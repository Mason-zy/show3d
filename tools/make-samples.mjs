/**
 * 生成 public/samples 下的测试文件。
 * 运行：npm run samples
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('public/samples');
fs.mkdirSync(OUT, { recursive: true });

const rand = (() => {
  let s = 20261123;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
})();

const noise = (x, z) =>
  Math.sin(x * 0.31) * Math.cos(z * 0.27) * 1.1 +
  Math.sin(x * 0.12 - z * 0.1) * 2.2 +
  Math.cos(z * 0.5 + 0.8) * 0.45;

const write = (name, data) => {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`  ${name.padEnd(16)} ${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0)} KB`);
};

/* ── 1. XYZ：场地 ─────────────────────────────────────────── */
function makeXyz() {
  const lines = [];
  for (let x = -12; x <= 12; x += 0.11) {
    for (let z = -12; z <= 12; z += 0.11) {
      const y = noise(x, z) + (rand() - 0.5) * 0.05;
      lines.push(`${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`);
    }
  }
  write('site.xyz', lines.join('\n'));
}

/* ── 2. LAS 1.2 / 点格式 2（RGB） ─────────────────────────── */
function makeLas() {
  const pts = [];
  // 建筑立面 + 地面
  for (let y = 0; y <= 9; y += 0.045) {
    for (let x = -6; x <= 6; x += 0.045) {
      const z = 0.9 * Math.sin(x * 0.25) + (rand() - 0.5) * 0.012;
      pts.push([x, y, z, 176, 182, 178]);
    }
  }
  for (let x = -14; x <= 14; x += 0.09) {
    for (let z = -9; z <= 9; z += 0.09) {
      if (z > -1.2 && z < 1.4) continue;
      const y = noise(x * 0.6, z * 0.6) * 0.25;
      pts.push([x, y, z + 2.2, 128, 140, 132]);
    }
  }

  const count = pts.length;
  const HEADER = 227;
  const REC = 26;
  const buf = Buffer.alloc(HEADER + count * REC);
  const scale = [0.001, 0.001, 0.001];
  const offset = [0, 0, 0];

  buf.write('LASF', 0, 'ascii');
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt32LE(0, 8);
  buf.writeUInt32LE(0, 12);
  buf.writeUInt8(1, 24);
  buf.writeUInt8(2, 25);
  buf.write('show3d samples'.padEnd(32, ' '), 26, 'ascii');
  buf.write('show3d sample gen'.padEnd(32, ' '), 58, 'ascii');
  buf.writeUInt16LE(2026, 90);
  buf.writeUInt16LE(1, 92);
  buf.writeUInt16LE(HEADER, 94);
  buf.writeUInt32LE(HEADER, 96);
  buf.writeUInt32LE(0, 100);
  buf.writeUInt8(2, 104); // point format 2, uncompressed
  buf.writeUInt16LE(REC, 105);
  buf.writeUInt32LE(count, 107);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  buf.writeDoubleLE(scale[0], 131); buf.writeDoubleLE(scale[1], 139); buf.writeDoubleLE(scale[2], 147);
  buf.writeDoubleLE(offset[0], 155); buf.writeDoubleLE(offset[1], 163); buf.writeDoubleLE(offset[2], 171);
  buf.writeDoubleLE(maxX, 179); buf.writeDoubleLE(minX, 187);
  buf.writeDoubleLE(maxY, 195); buf.writeDoubleLE(minY, 203);
  buf.writeDoubleLE(maxZ, 211); buf.writeDoubleLE(minZ, 219);

  let o = HEADER;
  for (const [x, y, z, r, g, b] of pts) {
    buf.writeInt32LE(Math.round(x / scale[0]), o);
    buf.writeInt32LE(Math.round(y / scale[1]), o + 4);
    buf.writeInt32LE(Math.round(z / scale[2]), o + 8);
    buf.writeUInt16LE(800 + Math.round(rand() * 2000), o + 12);
    buf.writeUInt8(9, o + 14); // return 1 of 1
    buf.writeUInt8(z < 0.4 ? 2 : 6, o + 15); // 地面 / 建筑
    buf.writeInt8(0, o + 16);
    buf.writeUInt8(0, o + 17);
    buf.writeUInt16LE(1, o + 18);
    buf.writeUInt16LE(r * 257, o + 20);
    buf.writeUInt16LE(g * 257, o + 22);
    buf.writeUInt16LE(b * 257, o + 24);
    o += REC;
  }
  write('scan.las', buf);
}

/* ── 3. PLY：点云（ascii，带 RGB） ────────────────────────── */
function makePlyCloud() {
  const rows = [];
  for (let x = -13; x <= 13; x += 0.1) {
    for (let z = -13; z <= 13; z += 0.1) {
      const d = Math.hypot(x, z);
      const y = Math.sin(d * 0.55) * 1.6 + noise(x * 0.4, z * 0.4) * 0.35 + (rand() - 0.5) * 0.03;
      const t = Math.min(1, Math.max(0, (y + 2) / 4));
      const r = Math.round(70 + t * 160);
      const g = Math.round(110 + t * 110);
      const b = Math.round(150 - t * 60);
      rows.push(`${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)} ${r} ${g} ${b}`);
    }
  }
  const head = [
    'ply',
    'format ascii 1.0',
    'comment show3d sample',
    `element vertex ${rows.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
  ].join('\n');
  write('scan.ply', `${head}\n${rows.join('\n')}\n`);
}

/* ── 4. PLY：网格（binary_little_endian） ─────────────────── */
function makePlyMesh() {
  // 起伏的方形网格
  const N = 46;
  const verts = [];
  const faces = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = (i / N - 0.5) * 10;
      const z = (j / N - 0.5) * 10;
      const y = Math.sin(x * 0.9) * Math.cos(z * 0.8) * 0.9;
      verts.push([x, y, z]);
    }
  }
  const idx = (i, j) => i * (N + 1) + j;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
      faces.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
    }
  }
  const head = [
    'ply',
    'format binary_little_endian 1.0',
    'comment show3d sample',
    `element vertex ${verts.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${faces.length}`,
    'property list uchar int vertex_indices',
    'end_header',
  ].join('\n') + '\n';

  const vbuf = Buffer.alloc(verts.length * 12);
  verts.forEach((v, k) => {
    vbuf.writeFloatLE(v[0], k * 12);
    vbuf.writeFloatLE(v[1], k * 12 + 4);
    vbuf.writeFloatLE(v[2], k * 12 + 8);
  });
  const fbuf = Buffer.alloc(faces.length * 13);
  faces.forEach((f, k) => {
    fbuf.writeUInt8(3, k * 13);
    fbuf.writeInt32LE(f[0], k * 13 + 1);
    fbuf.writeInt32LE(f[1], k * 13 + 5);
    fbuf.writeInt32LE(f[2], k * 13 + 9);
  });
  write('mesh.ply', Buffer.concat([Buffer.from(head, 'ascii'), vbuf, fbuf]));
}

/* ── 5. PCD：路面 ─────────────────────────────────────────── */
function makePcd() {
  const pts = [];
  for (let t = 0; t < 260; t++) {
    const along = (t / 260 - 0.5) * 40;
    const curve = Math.sin(along * 0.12) * 4;
    for (let w = -3.2; w <= 3.2; w += 0.05) {
      const x = along;
      const z = curve + w;
      const y = Math.sin(along * 0.3) * 0.08 + (rand() - 0.5) * 0.02;
      const shade = w > 0.2 ? 1 : 0.72;
      const r = Math.round(210 * shade);
      const g = Math.round(208 * shade);
      const b = Math.round(198 * shade);
      pts.push([x, y, z, r, g, b]);
    }
  }
  const pack = (r, g, b) => {
    const v = (r << 16) | (g << 8) | b;
    const f = new Float32Array(1);
    const i = new Int32Array(f.buffer);
    i[0] = v;
    return f[0];
  };
  const head = [
    '# .PCD v0.7 - Point Cloud Data file format',
    'VERSION 0.7',
    'FIELDS x y z rgb',
    'SIZE 4 4 4 4',
    'TYPE F F F F',
    'COUNT 1 1 1 1',
    `WIDTH ${pts.length}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${pts.length}`,
    'DATA ascii',
  ].join('\n');
  const rows = pts.map(
    ([x, y, z, r, g, b]) => `${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} ${pack(r, g, b)}`
  );
  write('road.pcd', `${head}\n${rows.join('\n')}\n`);
}

/* ── 6. GLB：亭子 ─────────────────────────────────────────── */
function boxMesh(cx, cy, cz, sx, sy, sz, verts, norms, idxs) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const faces = [
    { n: [0, 0, 1], c: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], c: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], c: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], c: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], c: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], c: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];
  for (const f of faces) {
    const base = verts.length / 3;
    for (const c of f.c) {
      verts.push(c[0] + cx, c[1] + cy, c[2] + cz);
      norms.push(...f.n);
    }
    idxs.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function makeGlb() {
  const verts = [];
  const norms = [];
  const idxs = [];

  boxMesh(0, -0.15, 0, 9, 0.3, 9, verts, norms, idxs); // 台基
  for (const [x, z] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]]) {
    boxMesh(x, 1.9, z, 0.34, 3.8, 0.34, verts, norms, idxs); // 柱
  }
  boxMesh(0, 4.0, 0, 8.4, 0.22, 8.4, verts, norms, idxs); // 梁
  // 屋顶：一层层收窄
  for (let i = 0; i < 7; i++) {
    const s = 8.6 - i * 1.1;
    boxMesh(0, 4.35 + i * 0.42, 0, s, 0.4, s, verts, norms, idxs);
  }
  boxMesh(0, 7.35, 0, 0.4, 1.1, 0.4, verts, norms, idxs); // 宝顶

  const posArr = new Float32Array(verts);
  const nrmArr = new Float32Array(norms);
  const idxArr = idxs.length > 65535 ? new Uint32Array(idxs) : new Uint16Array(idxs);

  const pad4 = (n) => (n + 3) & ~3;
  const binParts = [];
  let offset = 0;
  const views = [];

  const pushView = (arr) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = pad4(bytes.length) - bytes.length;
    views.push({ offset, length: bytes.length });
    binParts.push(bytes, Buffer.alloc(pad));
    offset += bytes.length + pad;
  };

  pushView(posArr);
  pushView(nrmArr);
  pushView(idxArr);

  const bin = Buffer.concat(binParts);

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < posArr.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], posArr[i + k]);
      max[k] = Math.max(max[k], posArr[i + k]);
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'show3d sample gen' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'pavilion' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.72, 0.73, 0.7, 1],
          metallicFactor: 0.05,
          roughnessFactor: 0.75,
        },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: posArr.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nrmArr.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: idxArr.byteLength === 2 * idxArr.length ? 5123 : 5125, count: idxArr.length, type: 'SCALAR' },
    ],
    bufferViews: views.map((v) => ({ buffer: 0, byteOffset: v.offset, byteLength: v.length })),
    buffers: [{ byteLength: bin.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)]);

  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);

  const jsonChunkHead = Buffer.alloc(8);
  jsonChunkHead.writeUInt32LE(jsonBuf.length, 0);
  jsonChunkHead.writeUInt32LE(0x4e4f534a, 4);

  const binChunkHead = Buffer.alloc(8);
  binChunkHead.writeUInt32LE(bin.length, 0);
  binChunkHead.writeUInt32LE(0x004e4942, 4);

  write('pavilion.glb', Buffer.concat([head, jsonChunkHead, jsonBuf, binChunkHead, bin]));
}

/* ── 7. OBJ：柱身 ─────────────────────────────────────────── */
function makeObj() {
  const seg = 48;
  const R = 1.4;
  const H = 6.4;
  const lines = ['# show3d sample', 'o column'];
  const v = (x, y, z) => lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);

  for (let ring = 0; ring < 4; ring++) {
    const y = -H / 2 + (H * ring) / 3;
    const r = ring === 0 ? R * 1.18 : ring === 3 ? R * 1.12 : R;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      v(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  v(0, H / 2 + 0.5, 0); // 顶心
  v(0, -H / 2, 0); // 底心
  const topCenter = 4 * seg + 1;
  const botCenter = 4 * seg + 2;

  for (let ring = 0; ring < 3; ring++) {
    for (let i = 0; i < seg; i++) {
      const a = ring * seg + i + 1;
      const b = ring * seg + ((i + 1) % seg) + 1;
      const c = (ring + 1) * seg + ((i + 1) % seg) + 1;
      const d = (ring + 1) * seg + i + 1;
      lines.push(`f ${a} ${b} ${c}`, `f ${a} ${c} ${d}`);
    }
  }
  for (let i = 0; i < seg; i++) {
    lines.push(`f ${topCenter} ${3 * seg + ((i + 1) % seg) + 1} ${3 * seg + i + 1}`);
    lines.push(`f ${botCenter} ${i + 1} ${((i + 1) % seg) + 1}`);
  }
  write('column.obj', `${lines.join('\n')}\n`);
}

/* ── 8. STL：支架（binary） ───────────────────────────────── */
function makeStl() {
  const tris = [];
  const addTri = (a, b, c) => tris.push([a, b, c]);

  // 一个带孔的圆环（简化：环状挤出）
  const seg = 64;
  const R = 2.6;
  const r = 0.7;
  const ringSeg = 14;
  const pt = (i, j) => {
    const a = (i / seg) * Math.PI * 2;
    const b = (j / ringSeg) * Math.PI * 2;
    const cx = Math.cos(a) * R;
    const cz = Math.sin(a) * R;
    return [
      cx + Math.cos(a) * Math.cos(b) * r,
      Math.sin(b) * r,
      cz + Math.sin(a) * Math.cos(b) * r,
    ];
  };
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < ringSeg; j++) {
      const a = pt(i, j);
      const b = pt(i + 1, j);
      const c = pt(i + 1, j + 1);
      const d = pt(i, j + 1);
      addTri(a, b, c);
      addTri(a, c, d);
    }
  }

  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('show3d torus bracket', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n) || 1;
    for (let k = 0; k < 3; k++) buf.writeFloatLE(n[k] / len, o + k * 4);
    for (let k = 0; k < 3; k++) {
      buf.writeFloatLE(a[k], o + 12 + k * 4);
      buf.writeFloatLE(b[k], o + 24 + k * 4);
      buf.writeFloatLE(c[k], o + 36 + k * 4);
    }
    buf.writeUInt16LE(0, o + 48);
    o += 50;
  }
  write('bracket.stl', buf);
}

console.log('生成示例文件：');
makeXyz();
makeLas();
makePlyCloud();
makePlyMesh();
makePcd();
makeGlb();
makeObj();
makeStl();
console.log('完成 →', OUT);
