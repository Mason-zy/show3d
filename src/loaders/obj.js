import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { extOf, baseOf, makeManager } from './util.js';

export const objLoader = {
  label: 'OBJ',
  kind: '模型',
  kinds: ['模型'],
  exts: ['obj'],
  async load(files, main, ctx) {
    const manager = ctx.manager || makeManager(files);
    const text = await main.text();

    let materials = null;
    const mtl = files.find((f) => extOf(f.name) === 'mtl');
    if (mtl) {
      try {
        const mtlLoader = new MTLLoader(manager);
        materials = mtlLoader.parse(await mtl.text(), '');
        materials.preload();
      } catch {
        materials = null;
      }
    }

    const loader = new OBJLoader(manager);
    if (materials) loader.setMaterials(materials);
    const group = loader.parse(text);

    let hasPoints = false;
    group.traverse((o) => {
      if (o.isPoints) hasPoints = true;
      if (o.isMesh && o.material) {
        o.material.side = THREE.DoubleSide;
        if (!o.material.map) {
          o.material.roughness = 0.75;
          o.material.metalness = 0.03;
        }
      }
    });

    if (!group.children.length) throw new Error('OBJ 里没有找到几何体');
    return { object3d: group, kind: hasPoints ? 'both' : 'mesh', units: null, sourceName: baseOf(main.name) };
  },
};
