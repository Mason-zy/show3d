import { gltfLoader } from './gltf.js';
import { objLoader } from './obj.js';
import { stlLoader } from './stl.js';
import { fbxLoader } from './fbx.js';
import { plyLoader } from './ply.js';
import { pcdLoader } from './pcd.js';
import { lasLoader } from './las.js';
import { xyzLoader } from './xyz.js';
import { extOf } from './util.js';

const LOADERS = [gltfLoader, objLoader, stlLoader, fbxLoader, plyLoader, pcdLoader, lasLoader, xyzLoader];

const EXT_MAP = new Map();
for (const l of LOADERS) for (const e of l.exts) EXT_MAP.set(e, l);

/** 这些是同批次拖进来的附属文件，不该被当成主文件 */
const AUX = new Set([
  'mtl', 'bin', 'png', 'jpg', 'jpeg', 'webp', 'ktx2', 'tga', 'bmp',
  'gif', 'exr', 'hdr', 'dds', 'pvr', 'basis', 'json',
]);

export const ACCEPT = LOADERS.flatMap((l) => l.exts.map((e) => `.${e}`)).join(',');

export function formatList() {
  const rows = [];
  for (const l of LOADERS) {
    rows.push({ name: l.exts.map((e) => `.${e}`).join(' / '), kind: l.kind });
  }
  return rows;
}

export function isSupported(name) {
  return EXT_MAP.has(extOf(name));
}

function pickMain(files) {
  const supported = files.filter((f) => EXT_MAP.has(extOf(f.name)));
  if (!supported.length) return null;
  const notAux = supported.filter((f) => !AUX.has(extOf(f.name)));
  return notAux[0] || supported[0];
}

export async function loadFiles(fileList, ctx) {
  const files = [...fileList];
  if (!files.length) throw new Error('没有选择文件');

  const main = pickMain(files);
  if (!main) {
    const exts = [...new Set(files.map((f) => extOf(f.name)).filter(Boolean))];
    throw new Error(`暂不支持 .${exts.join(' / .') || '未知'} 格式`);
  }

  const loader = EXT_MAP.get(extOf(main.name));
  const t0 = performance.now();
  const res = await loader.load(files, main, ctx);

  if (!res.object3d) throw new Error('文件里没有可显示的内容');

  return {
    ...res,
    elapsed: performance.now() - t0,
    formatLabel: loader.label,
    fileName: main.name,
    fileSize: files.reduce((s, f) => s + f.size, 0),
  };
}
