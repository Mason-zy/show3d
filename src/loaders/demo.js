import * as THREE from 'three';
import { makePoints } from './util.js';

/**
 * 开场就摆一块"现场"——不是空盒子。
 * 程序生成的场地扫描：起伏地形 + 一栋楼 + 一根杆。
 * 坐标系跟着测绘数据走：XY 是地面，Z 朝上。
 */

function terrain(x, y) {
  return (
    Math.sin(x * 0.32) * Math.cos(y * 0.27) * 1.05 +
    Math.sin(x * 0.11 - y * 0.09) * 2.35 +
    Math.cos(y * 0.48 + 1.2) * 0.5 +
    Math.exp(-((x - 5.5) ** 2 + (y + 6.5) ** 2) / 26) * 3.0
  );
}

// 便宜的确定性噪声
function jitter(i, k) {
  const n = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return n - Math.floor(n) - 0.5;
}

export function buildDemoSite() {
  const pos = [];
  const push = (x, y, z) => pos.push(x, y, z);

  // 地形：XY 平面采样，Z 是高度
  const half = 14;
  const step = 0.135;
  for (let x = -half; x <= half; x += step) {
    for (let y = -half; y <= half; y += step) {
      const z = terrain(x, y) + jitter(x * 100, y * 100) * 0.055;
      push(x, y, z);
    }
  }

  // 建筑：x 3.4–9.6，y -3.2–3.4
  const bx0 = 3.4, bx1 = 9.6, by0 = -3.2, by1 = 3.4;
  const baseZ = 2.9;
  const topZ = 8.6;
  const zMid = (baseZ + topZ) / 2;

  // 屋顶
  for (let x = bx0; x <= bx1; x += 0.11) {
    for (let y = by0; y <= by1; y += 0.11) {
      push(x, y, topZ + jitter(x * 77, y * 55) * 0.03);
    }
  }
  // 四面墙
  const wallStep = 0.1;
  for (let z = baseZ; z <= topZ; z += wallStep) {
    for (let x = bx0; x <= bx1; x += wallStep) {
      push(x, by0, z + jitter(x, z) * 0.02);
      push(x, by1, z + jitter(x, z * 3) * 0.02);
    }
    for (let y = by0; y <= by1; y += wallStep) {
      push(bx0, y, z + jitter(y, z) * 0.02);
      push(bx1, y, z + jitter(y, z * 5) * 0.02);
    }
  }
  void zMid;

  // 一根杆
  const px = -6.5, py = 4.2, pz0 = terrain(px, py);
  for (let z = 0; z <= 6.2; z += 0.07) {
    push(px + jitter(z, 1) * 0.012, py + jitter(z, 2) * 0.012, pz0 + z);
  }

  const positions = new Float32Array(pos);
  const points = makePoints(positions, null, null);
  points.userData.demo = true;
  return {
    object3d: points,
    kind: 'cloud',
    units: 'm',
    upAxis: 'z',
    note: `示例场地 · ${(positions.length / 3).toLocaleString('en-US')} 点`,
  };
}

export const DEMO_STATS = { label: '示例场地', meta: '程序生成' };
