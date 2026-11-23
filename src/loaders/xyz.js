import * as THREE from 'three';
import { makePoints } from './util.js';

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseLine(line) {
  const parts = line.trim().split(/[\s,;]+/);
  if (parts.length < 3) return null;
  const vals = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = Number(parts[i]);
    if (!NUM.test(parts[i])) return null;
    vals[i] = v;
  }
  return vals;
}

export const xyzLoader = {
  label: 'XYZ / TXT',
  kind: '点云',
  kinds: ['点云'],
  exts: ['xyz', 'txt', 'pts', 'csv'],
  async load(files, main) {
    const text = await main.text();
    const lines = text.split(/\r?\n/);

    let cols = 0;
    let sampleMax = [0, 0, 0];
    let sampled = 0;

    // 先摸一遍列数，判断第 4–6 列是不是 0–255 的颜色
    for (const line of lines) {
      if (!line || line.length < 3) continue;
      const v = parseLine(line);
      if (!v) continue;
      if (!cols) cols = v.length;
      if (v.length >= 6 && sampled < 400) {
        sampleMax[0] = Math.max(sampleMax[0], v[3]);
        sampleMax[1] = Math.max(sampleMax[1], v[4]);
        sampleMax[2] = Math.max(sampleMax[2], v[5]);
        sampled++;
      }
      if (sampled >= 400) break;
    }
    if (!cols) throw new Error('没有解析到任何点');

    const hasColor = sampled > 0 && Math.max(...sampleMax) > 1.2;
    const posList = [];
    const colList = hasColor ? [] : null;

    for (const line of lines) {
      if (!line || line.length < 3) continue;
      const v = parseLine(line);
      if (!v) continue;
      posList.push(v[0], v[1], v[2]);
      if (hasColor) {
        const n = Math.max(...sampleMax) > 255 ? 1 / 65535 : 1 / 255;
        colList.push(v[3] * n, v[4] * n, v[5] * n);
      }
    }

    const count = posList.length / 3;
    if (!count) throw new Error('没有解析到任何点');

    let positions = new Float32Array(posList);
    let colors = colList ? new Float32Array(colList) : null;

    // 坐标太远时先收缩到合理范围，避免 float32 抖动
    const box = new THREE.Box3().setFromArray(positions);
    const diag = box.getSize(new THREE.Vector3()).length();
    if (diag > 1e6 || (diag < 1e-4 && diag > 0)) {
      const scale = diag > 1e6 ? 1e4 / diag : 1e-1 / diag;
      for (let i = 0; i < positions.length; i++) positions[i] *= scale;
    }

    const points = makePoints(positions, colors, null);
    return {
      object3d: points,
      kind: 'cloud',
      units: null,
      upAxis: 'z',
      note: `${count.toLocaleString('en-US')} 点 · ${cols} 列${hasColor ? ' · 含 RGB' : ''}`,
    };
  },
};
