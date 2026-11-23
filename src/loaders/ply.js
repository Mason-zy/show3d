import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { makeMesh, makePoints } from './util.js';

const TYPE_SIZE = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function readScalar(dv, off, type, le) {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(off);
    case 'uchar': case 'uint8': return dv.getUint8(off);
    case 'short': case 'int16': return dv.getInt16(off, le);
    case 'ushort': case 'uint16': return dv.getUint16(off, le);
    case 'int': case 'int32': return dv.getInt32(off, le);
    case 'uint': case 'uint32': return dv.getUint32(off, le);
    case 'float': case 'float32': return dv.getFloat32(off, le);
    case 'double': case 'float64': return dv.getFloat64(off, le);
    default: return 0;
  }
}

/** 读 PLY 头，判断它到底是网格 / 点云 / 高斯泼溅 */
async function sniff(file) {
  const slice = await file.slice(0, 262144).arrayBuffer();
  const bytes = new Uint8Array(slice);
  const text = new TextDecoder('latin1').decode(bytes);
  if (!text.startsWith('ply')) throw new Error('不是 PLY 文件');

  const end = text.indexOf('end_header');
  if (end < 0) throw new Error('PLY 头部不完整');
  const headerLen = end + 'end_header'.length;
  // 头尾还有换行
  let dataStart = bytes[headerLen] === 13 && bytes[headerLen + 1] === 10 ? headerLen + 2 : headerLen + 1;

  const lines = text.slice(0, end).split(/\r?\n/);
  let format = 'ascii';
  let current = null;
  const elements = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('format ')) format = line.split(/\s+/)[1];
    if (line.startsWith('element ')) {
      const [, name, count] = line.split(/\s+/);
      current = { name, count: parseInt(count, 10), props: [] };
      elements.push(current);
    } else if (line.startsWith('property ') && current) {
      const parts = line.split(/\s+/);
      if (parts[1] === 'list') {
        current.props.push({ name: parts[4], list: true, countType: parts[2], type: parts[3] });
      } else {
        current.props.push({ name: parts[2], list: false, type: parts[1] });
      }
    }
  }

  const vertexEl = elements.find((e) => e.name === 'vertex');
  const faceEl = elements.find((e) => e.name === 'face');
  const propNames = new Set((vertexEl?.props || []).map((p) => p.name));

  const isSplat = ['f_dc_0', 'scale_0', 'rot_0', 'opacity'].some((p) => propNames.has(p));
  const isMesh = !!faceEl && faceEl.count > 0;

  return {
    format,
    dataStart,
    elements,
    vertexEl,
    isSplat,
    isMesh,
    binary: format !== 'ascii',
    endian: format === 'binary_big_endian' ? false : true,
  };
}

/** 高斯泼溅：自己按属性表读 xyz + f_dc_* */
async function parseSplat(file, head) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const v = head.vertexEl;
  const count = v.count;
  const le = head.endian;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const find = (n) => v.props.findIndex((p) => p.name === n);
  const iX = find('x'), iY = find('y'), iZ = find('z');
  const iDc0 = find('f_dc_0'), iDc1 = find('f_dc_1'), iDc2 = find('f_dc_2');
  const iR = find('red'), iG = find('green'), iB = find('blue');
  const hasDc = iDc0 >= 0 && iDc1 >= 0 && iDc2 >= 0;
  const hasRgb = iR >= 0 && iG >= 0 && iB >= 0;

  const SH_C0 = 0.28209479177387814;

  if (head.format === 'ascii') {
    const text = new TextDecoder().decode(buf);
    const body = text.slice(head.dataStart).trim().split(/\r?\n/);
    const n = Math.min(count, body.length);
    for (let i = 0; i < n; i++) {
      const parts = body[i].trim().split(/\s+/);
      positions[i * 3] = +parts[iX];
      positions[i * 3 + 1] = +parts[iY];
      positions[i * 3 + 2] = +parts[iZ];
      if (hasDc) {
        colors[i * 3] = Math.min(1, Math.max(0, +parts[iDc0] * SH_C0 + 0.5));
        colors[i * 3 + 1] = Math.min(1, Math.max(0, +parts[iDc1] * SH_C0 + 0.5));
        colors[i * 3 + 2] = Math.min(1, Math.max(0, +parts[iDc2] * SH_C0 + 0.5));
      } else if (hasRgb) {
        colors[i * 3] = +parts[iR] / 255;
        colors[i * 3 + 1] = +parts[iG] / 255;
        colors[i * 3 + 2] = +parts[iB] / 255;
      }
    }
  } else {
    // 行宽：定长属性之和
    let rowSize = 0;
    const offsets = [];
    for (const p of v.props) {
      offsets.push(rowSize);
      rowSize += TYPE_SIZE[p.type] || 4;
    }
    for (let i = 0; i < count; i++) {
      const base = head.dataStart + i * rowSize;
      positions[i * 3] = readScalar(dv, base + offsets[iX], v.props[iX].type, le);
      positions[i * 3 + 1] = readScalar(dv, base + offsets[iY], v.props[iY].type, le);
      positions[i * 3 + 2] = readScalar(dv, base + offsets[iZ], v.props[iZ].type, le);
      if (hasDc) {
        colors[i * 3] = Math.min(1, Math.max(0, readScalar(dv, base + offsets[iDc0], v.props[iDc0].type, le) * SH_C0 + 0.5));
        colors[i * 3 + 1] = Math.min(1, Math.max(0, readScalar(dv, base + offsets[iDc1], v.props[iDc1].type, le) * SH_C0 + 0.5));
        colors[i * 3 + 2] = Math.min(1, Math.max(0, readScalar(dv, base + offsets[iDc2], v.props[iDc2].type, le) * SH_C0 + 0.5));
      } else if (hasRgb) {
        const norm = v.props[iR].type.includes('float') ? 1 : 255;
        colors[i * 3] = readScalar(dv, base + offsets[iR], v.props[iR].type, le) / norm;
        colors[i * 3 + 1] = readScalar(dv, base + offsets[iG], v.props[iG].type, le) / norm;
        colors[i * 3 + 2] = readScalar(dv, base + offsets[iB], v.props[iB].type, le) / norm;
      }
    }
  }

  return { positions, colors, count };
}

export const plyLoader = {
  label: 'PLY',
  kind: '模型 / 点云',
  kinds: ['模型', '点云'],
  exts: ['ply'],
  async load(files, main) {
    const head = await sniff(main);

    if (head.isSplat) {
      const { positions, colors, count } = await parseSplat(main, head);
      const points = makePoints(positions, colors, null);
      points.userData.splat = true;
      return {
        object3d: points,
        kind: 'cloud',
        units: null,
        note: `高斯泼溅，按点云近似预览 · ${count.toLocaleString('en-US')} 个高斯`,
      };
    }

    const buf = await main.arrayBuffer();
    const geo = new PLYLoader().parse(buf);

    if (head.isMesh) {
      const mesh = makeMesh(geo, { color: 0x93a09a });
      mesh.material.roughness = 0.78;
      return { object3d: mesh, kind: 'mesh', units: null };
    }

    const pos = geo.getAttribute('position');
    const colorAttr = geo.getAttribute('color');
    const positions = new Float32Array(pos.array);
    const colors = colorAttr ? new Float32Array(colorAttr.array) : null;
    if (colors && colors.length > pos.count * 3) colors.length = pos.count * 3;
    const points = makePoints(positions, colors, null);
    return { object3d: points, kind: 'cloud', units: null };
  },
};
