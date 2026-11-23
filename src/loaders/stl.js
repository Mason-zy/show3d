import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { makeMesh } from './util.js';

export const stlLoader = {
  label: 'STL',
  kind: '模型',
  kinds: ['模型'],
  exts: ['stl'],
  async load(files, main) {
    const buf = await main.arrayBuffer();
    const geo = new STLLoader().parse(buf);
    if (!geo.getAttribute('position')) throw new Error('STL 解析失败');
    geo.computeVertexNormals();
    const mesh = makeMesh(geo, { flat: true, color: 0x95a29b });
    mesh.material.roughness = 0.85;
    return { object3d: mesh, kind: 'mesh', units: null };
  },
};
