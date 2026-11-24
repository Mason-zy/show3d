import * as THREE from 'three';

/**
 * 扫描轨迹。见过的位姿文件至少三种长相：
 *   1. jsonl —— 每行一个对象：sensor_pose.position + yaw_deg / pitch_deg
 *   2. json 数组 —— [{ pos: [x,y,z], yaw, pitch }, …]
 *   3. json 对象 —— 站点挂在 stations / poses / frames 下面，
 *      旁边还夹着传感器型号、点数、时长这类元信息
 * 所以这里不认死字段名，按形状猜；猜不到朝向就只画站点和路径。
 */

const C_DOT = 0x123a5c;
const C_PATH = 0x2b5b82;
const C_ARROW = 0x8a9792;

const POS_KEYS = [
  'position', 'pos', 'translation', 'xyz', 'coordinate', 'coordinates',
  'location', 'offset', 'center',
];
const LIST_KEYS = [
  'stations', 'poses', 'frames', 'trajectory', 'path', 'samples',
  'scans', 'cameras', 'items', 'data', 'vertices',
];
const RING_KEYS = ['station', 'ring', 'group', 'scan', 'line', 'name'];
const YAW_KEYS = ['yaw_deg', 'yaw', 'heading_deg', 'heading', 'azimuth_deg', 'azimuth'];
const PITCH_KEYS = ['pitch_deg', 'pitch', 'elevation_deg', 'elevation', 'tilt_deg', 'tilt'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** [x,y,z] 或 { x, y, z | altitude } 都收 */
function vec3(v) {
  if (Array.isArray(v)) {
    if (v.length < 3) return null;
    const p = v.slice(0, 3).map(Number);
    return p.every(Number.isFinite) ? p : null;
  }
  if (v && typeof v === 'object') {
    const x = num(v.x ?? v.X);
    const y = num(v.y ?? v.Y);
    const z = num(v.z ?? v.Z ?? v.altitude ?? v.height);
    return x !== null && y !== null && z !== null ? [x, y, z] : null;
  }
  return null;
}

function pickAngle(pose, entry, keys) {
  for (const k of keys) {
    const raw = pose?.[k] ?? entry?.[k];
    const v = num(raw);
    if (v !== null) return { v, deg: k.endsWith('_deg') };
  }
  return null;
}

/** 一条记录 → 一个站位。认不出坐标就返回 null */
function toRow(entry) {
  if (Array.isArray(entry)) {
    const pos = vec3(entry);
    return pos
      ? { pos, yaw: null, pitch: null, deg: false, orient: false, ringKey: null, points: 0 }
      : null;
  }
  if (!entry || typeof entry !== 'object') return null;

  const pose = entry.sensor_pose || entry.pose || entry.camera || entry.transform || entry;

  let pos = null;
  for (const k of POS_KEYS) {
    pos = vec3(pose?.[k]) || vec3(entry[k]);
    if (pos) break;
  }
  if (!pos) return null;

  const yaw = pickAngle(pose, entry, YAW_KEYS);
  const pitch = pickAngle(pose, entry, PITCH_KEYS);

  let ringKey = null;
  for (const k of RING_KEYS) {
    const v = entry[k];
    if (v != null && typeof v !== 'object') {
      ringKey = String(v).split(/[_-]/)[0];
      break;
    }
  }

  return {
    pos,
    yaw: yaw ? yaw.v : null,
    pitch: pitch ? pitch.v : null,
    deg: !!(yaw?.deg || pitch?.deg),
    orient: !!(yaw || pitch),
    ringKey,
    points: num(entry.points ?? entry.num_points ?? entry.count) || 0,
  };
}

/** 元信息：传感器型号、点数、时长 —— 只用来写说明 */
function readMeta(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const meta = {};
  if (doc.sensor || doc.device || doc.scanner) meta.sensor = String(doc.sensor || doc.device || doc.scanner);
  if (num(doc.points) !== null) meta.points = num(doc.points);
  if (num(doc.seconds) !== null) meta.seconds = num(doc.seconds);
  return Object.keys(meta).length ? meta : null;
}

function parseLines(text) {
  const rows = [];
  let meta = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const row = toRow(o);
    if (row) {
      rows.push(row);
      if (!meta) meta = readMeta(o);
    }
  }
  return { rows, meta };
}

/** 数组里挑出第一条认得出坐标的条目，作为站点表 */
function collectFromDoc(doc) {
  if (Array.isArray(doc)) {
    const rows = doc.map(toRow).filter(Boolean);
    return rows.length ? { rows, meta: null } : null;
  }
  if (!doc || typeof doc !== 'object') return null;

  for (const k of LIST_KEYS) {
    const list = doc[k];
    if (!Array.isArray(list) || !list.length) continue;
    const rows = list.map(toRow).filter(Boolean);
    if (rows.length) return { rows, meta: readMeta(doc) };
  }

  const one = toRow(doc);
  if (one) return { rows: [one], meta: readMeta(doc) };
  return null;
}

function parseText(text) {
  const t = text.trim();
  if (!t) return { rows: [], meta: null };

  if (t[0] === '{' || t[0] === '[') {
    // 整份 JSON 能解析就按文档走；解析失败说明是 jsonl，落到逐行
    try {
      const found = collectFromDoc(JSON.parse(t));
      if (found) return found;
    } catch {
      /* 不是单份 JSON */
    }
  }
  return parseLines(t);
}

/**
 * 分组：同一组的站位才连线。
 * 有显式 ring/station 字段就用它；否则按高度分层（三圈扫描的常见形态）；
 * 高度连续变化（螺旋轨迹）就不分组，整条按文件顺序连成一根线。
 * 带上文件序号，免得两个文件里同高度的圈被连到一起。
 */
function assignRings(rows) {
  let keyOf = rows.some((r) => r.ringKey !== null)
    ? (r) => r.ringKey
    : (r) => r.pos[2].toFixed(2);

  const uniq = new Set(rows.map(keyOf));
  if (uniq.size === rows.length && rows.length > 2) keyOf = () => 'path';

  rows.forEach((r) => {
    r.ring = `${r.src ?? 0}|${keyOf(r)}`;
  });
}

export const posesLoader = {
  label: '位姿轨迹',
  kind: 'trajectory',
  kinds: ['轨迹'],
  exts: ['jsonl'],
  // 只有内容像位姿表的 .json 才走这里，跟 .jsonl 平级列出
  alsoExts: ['json'],
  async load(files, main) {
    const targets = files.filter((f) => /\.(jsonl|json)$/i.test(f.name));
    if (!targets.length) targets.push(main);

    const rows = [];
    const metas = [];
    for (let i = 0; i < targets.length; i++) {
      const { rows: r, meta } = parseText(await targets[i].text());
      for (const row of r) {
        row.src = i;
        rows.push(row);
      }
      if (meta) metas.push(meta);
    }
    if (!rows.length) {
      throw new Error('没认出位姿：需要 position / pos 之类的坐标字段');
    }

    const hasOrient = rows.some((r) => r.orient);

    // 角度单位：显式 _deg 后缀，或者数值明显超过 π（弧度不可能这么大）
    let maxAbs = 0;
    for (const r of rows) maxAbs = Math.max(maxAbs, Math.abs(r.yaw ?? 0), Math.abs(r.pitch ?? 0));
    const inDeg = rows.some((r) => r.deg) || maxAbs > Math.PI + 1e-3;
    const k = inDeg ? Math.PI / 180 : 1;
    for (const r of rows) {
      r.yaw = (r.yaw ?? 0) * k;
      r.pitch = (r.pitch ?? 0) * k;
    }

    assignRings(rows);

    const count = rows.length;
    const pos = new Float32Array(count * 3);
    rows.forEach((r, i) => {
      pos[i * 3] = r.pos[0];
      pos[i * 3 + 1] = r.pos[1];
      pos[i * 3 + 2] = r.pos[2];
    });

    const box = new THREE.Box3().setFromArray(pos);
    const diag = box.getSize(new THREE.Vector3()).length() || 1;

    const group = new THREE.Group();

    // 站位点
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dots = new THREE.Points(
      dotGeo,
      new THREE.PointsMaterial({ size: diag * 0.022, sizeAttenuation: true, color: C_DOT })
    );
    dots.userData.fixedColor = true;
    group.add(dots);

    // 同组内按顺序连线（组之间不连，否则会拉出长跨线）
    const seg = [];
    for (let i = 1; i < count; i++) {
      if (rows[i].ring !== rows[i - 1].ring) continue;
      seg.push(...rows[i - 1].pos, ...rows[i].pos);
    }
    if (seg.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      const lines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: C_PATH, transparent: true, opacity: 0.7 })
      );
      lines.userData.fixedColor = true;
      group.add(lines);
    }

    // 朝向：yaw 绕 Z，pitch 抬起
    if (hasOrient) {
      const len = diag * 0.11;
      const arrows = [];
      for (const r of rows) {
        if (!r.orient) continue;
        const cy = Math.cos(r.yaw) * Math.cos(r.pitch);
        const sy = Math.sin(r.yaw) * Math.cos(r.pitch);
        const sz = Math.sin(r.pitch);
        arrows.push(
          r.pos[0], r.pos[1], r.pos[2],
          r.pos[0] + cy * len, r.pos[1] + sy * len, r.pos[2] + sz * len
        );
      }
      const ag = new THREE.BufferGeometry();
      ag.setAttribute('position', new THREE.Float32BufferAttribute(arrows, 3));
      const arrowLines = new THREE.LineSegments(
        ag,
        new THREE.LineBasicMaterial({ color: C_ARROW, transparent: true, opacity: 0.9 })
      );
      arrowLines.userData.fixedColor = true;
      group.add(arrowLines);
    }

    const rings = new Set(rows.map((r) => r.ring)).size;
    const meta = Object.assign({}, ...metas);
    const shots = rows.reduce((s, r) => s + r.points, 0) || meta.points || 0;

    const bits = [`${count} 个站位`, `${rings} 组`];
    if (meta.sensor) bits.push(meta.sensor);
    if (shots) bits.push(`覆盖 ${shots.toLocaleString('en-US')} 点`);
    if (meta.seconds) bits.push(`${Math.round(meta.seconds)} 秒`);

    return {
      object3d: group,
      kind: 'trajectory',
      units: 'm',
      upAxis: 'z',
      note: bits.join(' · '),
    };
  },
};
