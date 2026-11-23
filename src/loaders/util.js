import * as THREE from 'three';
import { lin } from '../core/colors.js';

export function extOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseOf(name = '') {
  return name.split(/[\\/]/).pop().toLowerCase();
}

export function readText(file) {
  return file.text();
}

export function readArrayBuffer(file) {
  return file.arrayBuffer();
}

/**
 * 让 three 的 loader 能解析同批次拖进来的贴图 / .mtl / .bin。
 * 相对路径 → 同名 File 的 blob URL。
 */
export function makeManager(files) {
  const manager = new THREE.LoadingManager();
  const byName = new Map();
  for (const f of files) byName.set(baseOf(f.name), f);
  const urls = new Map();

  manager.setURLModifier((url) => {
    if (/^(blob:|data:|https?:)/i.test(url)) return url;
    const name = baseOf(decodeURIComponent(url.split('?')[0]));
    const file = byName.get(name);
    if (!file) return url;
    if (!urls.has(name)) urls.set(name, URL.createObjectURL(file));
    return urls.get(name);
  });

  manager.disposeUrls = () => {
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  };
  return manager;
}

export function makePoints(positions, colors, classes, size = 0.05) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    vertexColors: false,
    color: 0x3f5668,
  });
  const points = new THREE.Points(geo, mat);
  if (colors) {
    // 文件里的 RGB 是 sRGB，顶点色要线性
    for (let i = 0; i < colors.length; i++) colors[i] = lin(colors[i]);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    points.userData.colors = colors;
  }
  if (classes) points.userData.classes = classes;
  return points;
}

export function makeMesh(geometry, { flat = false, color = 0x8f9c96 } = {}) {
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.04,
    flatShading: flat,
    // 第三方导出文件的绕序经常不一致，查看器不能靠背面剔除
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, mat);
}

/** 居中并返回 bbox —— 点云坐标常常大到 1e6，先平移回原点再给相机 */
export function normalize(object3d, transformFn) {
  if (transformFn) transformFn(object3d);
  object3d.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center);
  object3d.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(object3d);
  return box2;
}

export function applyPointScale(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const diag = box.getSize(new THREE.Vector3()).length() || 1;

  let total = 0;
  object3d.traverse((o) => {
    if (o.isPoints) total += o.geometry.getAttribute('position')?.count || 0;
  });

  // 点多就自动变小，否则千万点会糊成一整块
  const density = Math.max(1, Math.sqrt(total / 250000));
  const size = Math.max((diag * 0.0032) / density, 1e-6);

  object3d.traverse((o) => {
    // 轨迹站点这类"装饰点"自己定尺寸，不跟点云一起缩
    if (o.isPoints && o.material && !o.userData.fixedColor) o.material.size = size;
  });
  return size;
}
