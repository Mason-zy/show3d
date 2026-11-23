import * as THREE from 'three';

/**
 * 扫描轨迹（poses.jsonl）。
 * 每行一帧：传感器位置 + yaw/pitch + 该帧点数。
 * 画成三样东西：站位点、同环连线、朝向箭头。
 */

const C_DOT = 0x123a5c;
const C_PATH = 0x2b5b82;
const C_ARROW = 0x8a9792;

function parsePoses(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const pose = o.sensor_pose || o.pose || o;
    const p = pose.position || o.position;
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = +p[0];
    const y = +p[1];
    const z = +p[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;

    rows.push({
      ring: String(o.station || o.ring || '').split(/[_-]/)[0] || 'r',
      pos: [x, y, z],
      yaw: ((+pose.yaw_deg || 0) * Math.PI) / 180,
      pitch: ((+pose.pitch_deg || 0) * Math.PI) / 180,
      points: +o.points || 0,
    });
  }
  return rows;
}

export const posesLoader = {
  label: '位姿轨迹',
  kind: 'trajectory',
  kinds: ['轨迹'],
  exts: ['jsonl'],
  async load(files, main) {
    const rows = parsePoses(await main.text());
    if (!rows.length) throw new Error('这个 jsonl 里没有识别到 sensor_pose.position');

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

    // 同环内按顺序连线（环之间不连，否则会拉出两条长跨线）
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
    const len = diag * 0.11;
    const arrows = [];
    for (const r of rows) {
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

    const rings = new Set(rows.map((r) => r.ring)).size;
    const shots = rows.reduce((s, r) => s + r.points, 0);

    return {
      object3d: group,
      kind: 'trajectory',
      units: 'm',
      upAxis: 'z',
      note: `${count} 个站位 · ${rings} 圈${shots ? ` · 覆盖 ${shots.toLocaleString('en-US')} 点` : ''}`,
    };
  },
};
