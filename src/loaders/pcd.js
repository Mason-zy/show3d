import * as THREE from 'three';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { makePoints } from './util.js';

export const pcdLoader = {
  label: 'PCD',
  kind: '点云',
  kinds: ['点云'],
  exts: ['pcd'],
  async load(files, main) {
    const buf = await main.arrayBuffer();
    const parsed = new PCDLoader().parse(buf);
    const geo = parsed.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) throw new Error('PCD 里没有点坐标');

    const positions = new Float32Array(pos.array);
    const c = geo.getAttribute('color');
    const colors = c ? new Float32Array(c.array) : null;

    const points = makePoints(positions, colors, null);
    return {
      object3d: points,
      kind: 'cloud',
      units: null,
      note: `${pos.count.toLocaleString('en-US')} 点`,
    };
  },
};
