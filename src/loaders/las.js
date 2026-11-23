import * as THREE from 'three';
import { makePoints } from './util.js';

/** 各点格式在记录内的字段偏移（intensity 恒在 12） */
const LAYOUT = {
  0: { rgb: -1, cls: 15 },
  1: { rgb: -1, cls: 15 },
  2: { rgb: 20, cls: 15 },
  3: { rgb: 28, cls: 15 },
  4: { rgb: -1, cls: 15 },
  5: { rgb: 28, cls: 15 },
  6: { rgb: -1, cls: 16 },
  7: { rgb: 30, cls: 16 },
  8: { rgb: 30, cls: 16 },
  9: { rgb: -1, cls: 16 },
  10: { rgb: 30, cls: 16 },
};

export function parseHeader(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 227) throw new Error('文件太小，不是 LAS');
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('缺少 LASF 文件头');

  const major = dv.getUint8(24);
  const minor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const offsetToPointData = dv.getUint32(96, true);
  const formatByte = dv.getUint8(104);
  const pointFormat = formatByte & 0x3f;
  const compressed = (formatByte & 0x80) !== 0;
  const pointLength = dv.getUint16(105, true);

  let count = dv.getUint32(107, true);
  if (minor >= 4 && headerSize >= 375) {
    const lo = dv.getUint32(247, true);
    const hi = dv.getUint32(251, true);
    const big = hi * 4294967296 + lo;
    if (big > 0) count = big;
  }
  if (count === 0) {
    // 某些 1.4 文件的 legacy 字段为 0
    const lo = dv.getUint32(247, true);
    if (lo) count = lo;
  }

  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];

  return {
    version: `${major}.${minor}`,
    pointFormat,
    compressed,
    pointLength,
    count,
    offsetToPointData,
    scale,
    offset,
  };
}

/** 把一段（已解压的）点记录读成属性数组 */
function decodeRecords(bytes, header, count, pointLength) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lay = LAYOUT[header.pointFormat] || LAYOUT[0];
  const [sx, sy, sz] = header.scale;
  const [ox, oy, oz] = header.offset;

  const positions = new Float32Array(count * 3);
  const classes = new Uint8Array(count);
  let colors = lay.rgb >= 0 ? new Float32Array(count * 3) : null;
  let rMax = 0;

  for (let i = 0; i < count; i++) {
    const o = i * pointLength;
    positions[i * 3] = dv.getInt32(o, true) * sx + ox;
    positions[i * 3 + 1] = dv.getInt32(o + 4, true) * sy + oy;
    positions[i * 3 + 2] = dv.getInt32(o + 8, true) * sz + oz;
    classes[i] = dv.getUint8(o + lay.cls);

    if (colors) {
      const r = dv.getUint16(o + lay.rgb, true);
      const g = dv.getUint16(o + lay.rgb + 2, true);
      const b = dv.getUint16(o + lay.rgb + 4, true);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;
      if (r > rMax) rMax = r;
      if (g > rMax) rMax = g;
      if (b > rMax) rMax = b;
    }
  }

  if (colors) {
    const norm = rMax > 255 ? 1 / 65535 : 1 / 255;
    for (let i = 0; i < colors.length; i++) colors[i] *= norm;
  }

  return { positions, colors, classes, count };
}

let lazPerfModule = null;

async function getLazPerf() {
  if (lazPerfModule) return lazPerfModule;
  const mod = await import('laz-perf');
  const create = mod.createLazPerf || mod.default?.createLazPerf || mod.default || mod.create;
  if (typeof create !== 'function') throw new Error('laz-perf 加载失败');
  lazPerfModule = await create({
    locateFile: (p) => new URL(p, document.baseURI).href,
  });
  return lazPerfModule;
}

async function decompressLaz(file, header, onProgress) {
  const module = await getLazPerf();
  // 注意：LASZip.open() 要的是完整 LAZ 文件（含头部与 laszip VLR），
  // 只给点数据段会直接抛 C++ 异常。
  const src = new Uint8Array(await file.arrayBuffer());

  const laszip = new module.LASZip();
  const srcPtr = module._malloc(src.byteLength);
  module.HEAPU8.set(src, srcPtr);
  laszip.open(srcPtr, src.byteLength);

  const count = laszip.getCount() || header.count;
  const pointLength = laszip.getPointLength();
  const out = new Uint8Array(count * pointLength);

  // 分块解压：一次 malloc 一整块，循环内直接写偏移，
  // 避免每个点都做一次 subarray + set（千万点级别能差好几秒）。
  // 块之间让出一帧，好让进度条有机会画出来。
  const CHUNK = 300000;
  const chunkBytes = CHUNK * pointLength;
  const bufPtr = module._malloc(chunkBytes);
  for (let i = 0; i < count; i += CHUNK) {
    const n = Math.min(CHUNK, count - i);
    for (let k = 0; k < n; k++) {
      laszip.getPoint(bufPtr + k * pointLength);
    }
    out.set(module.HEAPU8.subarray(bufPtr, bufPtr + n * pointLength), i * pointLength);
    if (onProgress) {
      onProgress((i + n) / count);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  module._free(srcPtr);
  module._free(bufPtr);
  laszip.delete();

  return { bytes: out, count, pointLength };
}

export const lasLoader = {
  label: 'LAS / LAZ',
  kind: '点云',
  kinds: ['点云'],
  exts: ['las', 'laz'],
  async load(files, main, ctx) {
    const headBuf = await main.slice(0, 2048).arrayBuffer();
    const header = parseHeader(headBuf);

    let decoded;
    if (main.name.toLowerCase().endsWith('.laz') || header.compressed) {
      const { bytes, count, pointLength } = await decompressLaz(main, header, (p) => {
        ctx?.onProgress?.(p, '解压中');
      });
      decoded = decodeRecords(bytes, header, count, pointLength);
    } else {
      const buf = await main.arrayBuffer();
      const bytes = new Uint8Array(buf, header.offsetToPointData);
      const count = Math.min(header.count, Math.floor(bytes.byteLength / header.pointLength));
      decoded = decodeRecords(bytes, header, count, header.pointLength);
    }

    if (!decoded.count) throw new Error('LAS 文件里没有点');

    const points = makePoints(decoded.positions, decoded.colors, decoded.classes);
    return {
      object3d: points,
      kind: 'cloud',
      units: 'm',
      upAxis: 'z',
      note: `LAS ${header.version} · 格式 ${header.pointFormat} · ${decoded.count.toLocaleString('en-US')} 点`,
    };
  },
};
