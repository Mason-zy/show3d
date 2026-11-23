import * as THREE from 'three';
import { makePoints } from './util.js';

/**
 * 开场就摆一块"现场"——不是空盒子。
 * 程序生成的场地扫描：起伏地形 + 一栋楼 + 一根杆。
 */

function terrain(x, z) {
  return (
    Math.sin(x * 0.32) * Math.cos(z * 0.27) * 1.05 +
    Math.sin(x * 0.11 - z * 0.09) * 2.35 +
    Math.cos(z * 0.48 + 1.2) * 0.5 +
    Math.exp(-((x - 5.5) ** 2 + (z + 6.5) ** 2) / 26) * 3.0
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

  // 地形
  const half = 14;
  const step = 0.135;
  for (let x = -half; x <= half; x += step) {
    for (let z = -half; z <= half; z += step) {
      const y = terrain(x, z) + jitter(x * 100, z * 100) * 0.055;
      push(x, y, z);
    }
  }

  // 建筑：x 3.4–9.6，z -3.2–3.4
  const bx0 = 3.4, bx1 = 9.6, bz0 = -3.2, bz1 = 3.4;
  const baseY = 2.9;
  const topY = 8.6;

  // 屋顶
  for (let x = bx0; x <= bx1; x += 0.11) {
    for (let z = bz0; z <= bz1; z += 0.11) {
      push(x, topY + jitter(x * 77, z * 55) * 0.03, z);
    }
  }
  // 四面墙
  const wallStep = 0.1;
  for (let y = baseY; y <= topY; y += wallStep) {
    for (let x = bx0; x <= bx1; x += wallStep) {
      push(x, y + jitter(x, y) * 0.02, bz0);
      push(x, y + jitter(x, y * 3) * 0.02, bz1);
    }
    for (let z = bz0; z <= bz1; z += wallStep) {
      push(bx0, y + jitter(z, y) * 0.02, z);
      push(bx1, y + jitter(z, y * 5) * 0.02, z);
    }
  }

  // 一根杆
  const px = -6.5, pz = 4.2, py0 = terrain(px, pz);
  for (let y = 0; y <= 6.2; y += 0.07) {
    push(px + jitter(y, 1) * 0.012, py0 + y, pz + jitter(y, 2) * 0.012);
  }

  const positions = new Float32Array(pos);
  const points = makePoints(positions, null, null);
  points.userData.demo = true;
  return {
    object3d: points,
    kind: 'cloud',
    units: 'm',
    note: `示例场地 · ${(positions.length / 3).toLocaleString('en-US')} 点`,
  };
}

export const DEMO_STATS = { label: '示例场地', meta: '程序生成' };
