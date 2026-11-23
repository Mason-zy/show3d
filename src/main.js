import './style.css';
import * as THREE from 'three';
import { Viewer, fmtNum } from './core/viewer.js';
import { loadFiles, ACCEPT, formatList, isSupported } from './loaders/registry.js';
import { buildDemoSite } from './loaders/demo.js';
import { makeManager, applyPointScale } from './loaders/util.js';

const $ = (id) => document.getElementById(id);

const ui = {
  stage: $('stage'),
  empty: $('empty'),
  veil: $('drop-veil'),
  toast: $('toast'),
  fileInput: $('file-input'),
  scalebar: $('scalebar'),
  scaleLabel: $('scalebar-label'),
  scaleRule: document.querySelector('.scalebar-rule'),
  roCursor: $('ro-cursor'),
  roPoints: $('ro-points'),
  roTris: $('ro-tris'),
  roFps: $('ro-fps'),
  specFormat: $('spec-format'),
  specName: $('spec-name'),
  specSize: $('spec-size'),
  specPoints: $('spec-points'),
  specTris: $('spec-tris'),
  specDims: $('spec-dims'),
  specTime: $('spec-time'),
  pointSize: $('point-size'),
  pointSizeV: $('point-size-v'),
  pointsNote: $('points-note'),
  seg: document.querySelector('.seg'),
  popover: $('formats-popover'),
  formatList: $('format-list'),
  samples: $('samples'),
};

const viewer = new Viewer($('view'));

if (import.meta.env.DEV) {
  window.__show3d = { viewer, get content() { return current; } };
}

let current = null;
let toastTimer = 0;
let dragDepth = 0;

/* ── 载入管线 ───────────────────────────────────────────── */

function centerCloud(object3d) {
  object3d.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = box.getCenter(new THREE.Vector3());
  if (!isFinite(center.x + center.y + center.z)) return box;

  object3d.traverse((o) => {
    if (!o.isPoints || !o.geometry) return;
    const p = o.geometry.getAttribute('position');
    if (!p) return;
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] -= center.x;
      a[i + 1] -= center.y;
      a[i + 2] -= center.z;
    }
    p.needsUpdate = true;
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });
  return new THREE.Box3().setFromObject(object3d);
}

function normalize(result) {
  const { object3d, kind } = result;
  if (kind === 'cloud' || kind === 'both') {
    const box = centerCloud(object3d);
    return box;
  }
  object3d.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center);
  object3d.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object3d);
}

function applyResult(result, opts = {}) {
  clearTimeout(toastTimer);
  ui.toast.classList.remove('is-on');

  const box = normalize(result);
  applyPointScale(result.object3d);

  const stats = viewer.statsOf(result.object3d);
  const size = box.getSize(new THREE.Vector3());

  viewer.setContent({
    object3d: result.object3d,
    bbox: box,
    stats,
    units: result.units || null,
    kind: result.kind,
  });
  viewer.setPointSize(parseFloat(ui.pointSize.value) / 1.4);
  viewer.setGrid($('opt-grid').checked);
  viewer.setAxes($('opt-axes').checked);
  viewer.setAutoRotate($('opt-spin').checked);

  const defaultMode = result.kind === 'mesh' ? 'solid' : 'height';
  setSegActive(defaultMode);
  viewer.setColorMode(defaultMode);

  current = { ...result, box, stats };

  // 标本标签
  ui.specFormat.textContent = result.formatLabel || '文件';
  ui.specFormat.classList.add('is-active');
  ui.specName.textContent = result.fileName || '示例';
  ui.specName.classList.remove('is-empty');
  ui.specSize.textContent = result.fileSize ? formatBytes(result.fileSize) : '';
  ui.specPoints.textContent = stats.points ? fmtNum(stats.points) : '—';
  ui.specTris.textContent = stats.triangles ? fmtNum(stats.triangles) : '—';
  ui.specDims.textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
  ui.specTime.textContent = result.elapsed ? `${Math.round(result.elapsed)} ms` : '—';

  ui.roPoints.textContent = fmtNum(stats.points);
  ui.roTris.textContent = fmtNum(stats.triangles);

  const isCloud = result.kind === 'cloud' || result.kind === 'both';
  ui.pointSize.disabled = !isCloud;
  ui.pointsNote.textContent = isCloud ? '越大越接近实景，越小越省性能' : '当前是网格模型';

  ui.empty.classList.toggle('is-hidden', !opts.keepEmpty);
  ui.scalebar.classList.add('is-on');

  if (!opts.silent) {
    runScanline();
    viewer.playReveal();
  }

  if (result.note && !opts.silent) toast(result.note);
}

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  const main = files.find((f) => isSupported(f.name)) || files[0];
  const big = main && main.size > 24 * 1024 * 1024;
  const ctx = {
    manager: makeManager(files),
    renderer: viewer.renderer,
    onProgress: (p, label) => {
      if (big) toast(`${label} ${Math.round(p * 100)}% · ${main.name}`, false, true);
    },
  };

  if (big) toast(`正在读取 ${main.name}（${formatBytes(main.size)}）…`, false, true);

  try {
    const result = await loadFiles(files, ctx);
    applyResult(result);
  } catch (err) {
    console.error(err);
    toast(err?.message || '这个文件打不开', true);
  } finally {
    ctx.manager?.disposeUrls?.();
  }
}

async function openSample(name, label) {
  try {
    const res = await fetch(`/samples/${name}`);
    if (!res.ok) throw new Error(`示例文件缺失：${name}`);
    const blob = await res.blob();
    await openFiles([new File([blob], name)]);
  } catch (err) {
    console.error(err);
    toast(`示例载入失败：${err.message}`, true);
  }
}

/* ── 界面 ───────────────────────────────────────────────── */

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function toast(msg, isError = false, sticky = false) {
  ui.toast.textContent = msg;
  ui.toast.classList.toggle('is-error', isError);
  ui.toast.classList.add('is-on');
  clearTimeout(toastTimer);
  if (!sticky) {
    toastTimer = setTimeout(() => ui.toast.classList.remove('is-on'), isError ? 4200 : 2600);
  }
}

function runScanline() {
  let el = document.querySelector('.scanline');
  if (!el) {
    el = document.createElement('div');
    el.className = 'scanline';
    ui.stage.appendChild(el);
  }
  el.classList.remove('is-run');
  void el.offsetWidth;
  el.classList.add('is-run');
}

viewer.onFrame = (fps) => {
  ui.roFps.textContent = `${fps}`;
};

viewer.onCursor = (p) => {
  if (!p) {
    ui.roCursor.textContent = '—';
    return;
  }
  const f = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  const unit = current?.units === 'm' ? ' m' : '';
  ui.roCursor.textContent = `${f(p.x)}  ${f(p.y)}  ${f(p.z)}${unit}`;
};

viewer.onScale = ({ len, px, unit }) => {
  ui.scaleRule.style.width = `${Math.round(px)}px`;
  const num = len >= 1 ? String(Math.round(len * 100) / 100) : String(len);
  ui.scaleLabel.textContent = unit === 'm' ? `${num} m` : num;
};

/* 控件 */
ui.fileInput.accept = ACCEPT;
ui.fileInput.addEventListener('change', (e) => {
  openFiles(e.target.files);
  e.target.value = '';
});

$('btn-shot').addEventListener('click', () => {
  const base = (current?.fileName || 'show3d').replace(/\.[^.]+$/, '');
  viewer.screenshot(`${base}.png`);
  toast('已保存截图');
});

$('btn-frame').addEventListener('click', () => viewer.frameContent());
$('view').addEventListener('dblclick', () => viewer.frameContent());

/* 格式弹层 */
$('btn-formats').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = ui.popover.hidden;
  ui.popover.hidden = !open;
  if (open) {
    ui.formatList.innerHTML = formatList()
      .map((f) => `<li><span class="fmt-name">${f.name}</span><span class="fmt-kind">${f.kind}</span></li>`)
      .join('');
  }
});
document.addEventListener('click', (e) => {
  if (!ui.popover.hidden && !ui.popover.contains(e.target)) ui.popover.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ui.popover.hidden = true;
});

/* 着色 */
function setSegActive(mode) {
  for (const b of ui.seg.children) b.classList.toggle('is-on', b.dataset.color === mode);
}

ui.seg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-item');
  if (!btn) return;
  setSegActive(btn.dataset.color);
  viewer.setColorMode(btn.dataset.color);
});

/* 点大小 */
ui.pointSize.addEventListener('input', () => {
  const v = parseFloat(ui.pointSize.value);
  ui.pointSizeV.textContent = v.toFixed(1);
  viewer.setPointSize(v / 1.4);
});

/* 场景开关 */
$('opt-grid').addEventListener('change', (e) => viewer.setGrid(e.target.checked));
$('opt-axes').addEventListener('change', (e) => viewer.setAxes(e.target.checked));
$('opt-spin').addEventListener('change', (e) => viewer.setAutoRotate(e.target.checked));

/* 拖拽 */
function showVeil(on) {
  ui.veil.classList.toggle('is-on', on);
}

ui.stage.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  showVeil(true);
});
ui.stage.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
ui.stage.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    showVeil(false);
  }
});
ui.stage.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  showVeil(false);
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});

// 页面其它区域也别让浏览器直接打开文件
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* 示例 */
const SAMPLES = [
  { file: 'site.xyz', label: '场地扫描', meta: 'XYZ' },
  { file: 'scan.las', label: '建筑立面', meta: 'LAS' },
  { file: 'scan.laz', label: '建筑立面·压缩', meta: 'LAZ' },
  { file: 'scan.ply', label: '河岸地形', meta: 'PLY 点云' },
  { file: 'road.pcd', label: '路面扫描', meta: 'PCD' },
  { file: 'pavilion.glb', label: '亭子模型', meta: 'GLB' },
  { file: 'column.obj', label: '柱身', meta: 'OBJ' },
  { file: 'bracket.stl', label: '圆环支架', meta: 'STL' },
  { file: 'mesh.ply', label: '起伏网格', meta: 'PLY 网格' },
];

ui.samples.innerHTML = SAMPLES.map(
  (s) => `<button class="sample-btn" data-file="${s.file}">
    <span class="sample-name">${s.label}</span>
    <span class="sample-meta">${s.meta}</span>
  </button>`
).join('');

ui.samples.addEventListener('click', (e) => {
  const btn = e.target.closest('.sample-btn');
  if (!btn) return;
  openSample(btn.dataset.file, btn.textContent.trim());
});

/* 开场：先摆一块场地，别让用户对着空盒子 */
const demo = buildDemoSite();
applyResult(
  { ...demo, formatLabel: '示例', fileName: '示例场地', elapsed: 0 },
  { keepEmpty: true, silent: true }
);

// 首屏给一次显影
setTimeout(() => viewer.playReveal(), 160);
