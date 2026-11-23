import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export const fbxLoader = {
  label: 'FBX',
  kind: '模型',
  kinds: ['模型'],
  exts: ['fbx'],
  async load(files, main, ctx) {
    const buf = await main.arrayBuffer();
    const loader = new FBXLoader(ctx.manager);
    const group = loader.parse(buf, '');
    if (!group || !group.children.length) throw new Error('FBX 解析失败');
    group.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if ('roughness' in m && m.roughness === undefined) m.roughness = 0.8;
        }
      }
    });
    return { object3d: group, kind: 'mesh', units: null, upAxis: 'y' };
  },
};
