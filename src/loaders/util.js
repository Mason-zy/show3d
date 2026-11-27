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

/**
 * 顶点色统一成 0–1 的 Float32。
 * three 的 loader 有的给 Float32（已经是 0–1），有的给 normalized Uint8（0–255），
 * 直接 `new Float32Array(attr.array)` 会把 0–255 当成 0–1，颜色全部糊成白色。
 */
export function colorToUnit(attr) {
  const src = attr.array;
  const out = new Float32Array(src.length);
  const max = src instanceof Uint8Array ? 255 : src instanceof Uint16Array ? 65535 : src instanceof Int8Array ? 127 : 0;
  const k = max && (attr.normalized || max === 255) ? 1 / max : 1;
  for (let i = 0; i < src.length; i++) out[i] = src[i] * k;
  return out;
}

/**
 * colorsLinear：调用方给的颜色是不是已经在**线性空间**。
 * three 的 PLYLoader / PCDLoader 内部已经做过 sRGB→线性（Color.setRGB(..., SRGBColorSpace)），
 * 传 true 就不要再转一次，否则颜色会整体压暗。
 */
export function makePoints(positions, colors, classes, size = 0.05, colorsLinear = false) {
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
    if (!colorsLinear) {
      for (let i = 0; i < colors.length; i++) colors[i] = lin(colors[i]);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // 属性缓冲会被"单色/高度/强度"这几种模式覆盖，原始色另存一份。
    // 按 8 位存：源数据本来就是 8 位，千万点也只多占 3 字节/点。
    const c8 = new Uint8Array(colors.length);
    for (let i = 0; i < colors.length; i++) c8[i] = Math.round(colors[i] * 255);
    points.userData.colors8 = c8;
  }
  if (classes) points.userData.classes = classes;
  return points;
}

/**
 * three 的渲染器只认 float32 顶点属性（WebGL 没有双精度），
 * 而 PLY 的 `property double` 会被解析成 Float64BufferAttribute，
 * 上传时直接抛 "Unsupported buffer data format"，画面一片空白。
 * 所以进场景前统一降精度——坐标是米级，float32 的 7 位有效数字足够。
 */
export function toFloat32(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name];
    if (!(attr.array instanceof Float64Array)) continue;
    geometry.setAttribute(
      name,
      new THREE.BufferAttribute(new Float32Array(attr.array), attr.itemSize, attr.normalized)
    );
  }
  return geometry;
}

export function makeMesh(geometry, { flat = false, color = 0x8f9c96 } = {}) {
  toFloat32(geometry);
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
