import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let draco = null;
let ktx2 = null;
let rendererRef = null;

function asset(p) {
  return new URL(p, document.baseURI).href;
}

function getDraco() {
  if (!draco) {
    draco = new DRACOLoader();
    draco.setDecoderPath(asset('draco/'));
    draco.setDecoderConfig({ type: 'wasm' });
  }
  return draco;
}

function getKtx2(renderer) {
  if (!ktx2 && renderer) {
    ktx2 = new KTX2Loader().setTranscoderPath(asset('basis/')).detectSupport(renderer);
    rendererRef = renderer;
  }
  return ktx2;
}

export const gltfLoader = {
  label: 'GLB / glTF',
  kind: '模型',
  kinds: ['模型', '点云'],
  exts: ['glb', 'gltf'],
  async load(files, main, ctx) {
    const url = URL.createObjectURL(main);
    try {
      const loader = new GLTFLoader(ctx.manager);
      loader.setDRACOLoader(getDraco());
      const ktx = getKtx2(ctx.renderer);
      if (ktx) loader.setKTX2Loader(ktx);
      loader.setMeshoptDecoder(MeshoptDecoder);

      const gltf = await loader.loadAsync(url);
      const scene = gltf.scene || gltf.scenes?.[0];
      if (!scene) throw new Error('glTF 里没有可显示的场景');

      let hasPoints = false;
      scene.traverse((o) => {
        if (o.isPoints) hasPoints = true;
      });

      return {
        object3d: scene,
        kind: hasPoints ? 'both' : 'mesh',
        units: 'm',
        upAxis: 'y',
        animations: gltf.animations || [],
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};
