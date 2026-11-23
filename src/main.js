import './style.css';
import * as THREE from 'three';
import { Viewer, fmtNum } from './core/viewer.js';
import { loadFiles, ACCEPT, formatList, isSupported } from './loaders/registry.js';
import { buildDemoSite } from './loaders/demo.js';
import { makeManager, applyPointScale } from './loaders/util.js';

const $ = (id) => document.getElementById(id);

const ui = {
  stage: $('stage'),
  viewport: $('viewport'),
  tabs: $('tabs'),
  tabList: $('tab-list'),
  tabAdd: $('tab-add'),
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
let session = 0;

const docs = [];
let demoDoc = null;
let active = null;
let docSeq = 0;
const MAX_TABS = 8;

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
  const { object3d, kind, upAxis = 'z' } = result;

  // glTF / OBJ / FBX 是 Y 朝上，世界的其余部分是 Z 朝上，这里转一次。
  if (upAxis === 'y') {
    object3d.rotation.x += Math.PI / 2;
    object3d.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object3d);
    const center = box.getCenter(new THREE.Vector3());
    object3d.position.sub(center);
    object3d.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(object3d);
  }

  if (kind === 'cloud' || kind === 'both') {
    return centerCloud(object3d);
  }

  object3d.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center);
  object3d.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(object3d);
}

function makeDoc(result) {
  const box = normalize(result);
  const pointBase = applyPointScale(result.object3d);
  const stats = viewer.statsOf(result.object3d);
  return {
    id: ++docSeq,
    name: result.fileName || '示例',
    formatLabel: result.formatLabel || '示例',
    fileSize: result.fileSize || 0,
    elapsed: result.elapsed || 0,
    note: result.note,
    units: result.units || null,
    kind: result.kind,
    object3d: result.object3d,
    box,
    stats,
    pointBase,
    view: null,
    prepared: false,
    colorMode: result.kind === 'mesh' ? 'solid' : 'height',
  };
}

function updateSpecimen(doc) {
  const size = doc.box.getSize(new THREE.Vector3());
  ui.specFormat.textContent = doc.formatLabel;
  ui.specFormat.classList.add('is-active');
  ui.specName.textContent = doc.name;
  ui.specName.classList.remove('is-empty');
  ui.specSize.textContent = doc.fileSize ? formatBytes(doc.fileSize) : '';
  ui.specPoints.textContent = doc.stats.points ? fmtNum(doc.stats.points) : '—';
  ui.specTris.textContent = doc.stats.triangles ? fmtNum(doc.stats.triangles) : '—';
  ui.specDims.textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
  ui.specTime.textContent = doc.elapsed ? `${Math.round(doc.elapsed)} ms` : '—';

  ui.roPoints.textContent = fmtNum(doc.stats.points);
  ui.roTris.textContent = fmtNum(doc.stats.triangles);

  const isCloud = doc.kind === 'cloud' || doc.kind === 'both';
  ui.pointSize.disabled = !isCloud;
  ui.pointsNote.textContent = isCloud ? '越大越接近实景，越小越省性能' : '当前是网格模型';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderTabs() {
  ui.tabs.hidden = docs.length === 0;
  ui.tabList.innerHTML = docs
    .map(
      (d) => `<div class="tab${d === active ? ' is-on' : ''}" data-id="${d.id}">
        <button class="tab-main" data-id="${d.id}" title="${esc(d.name)}">
          <span class="tab-name">${esc(d.name)}</span>
        </button>
        <button class="tab-x" data-close="${d.id}" title="关闭">×</button>
      </div>`
    )
    .join('');
}

function activate(doc, opts = {}) {
  if (!doc) return;
  active = doc;
  current = doc;

  viewer.show(doc);
  viewer.setGrid($('opt-grid').checked);
  viewer.setAxes($('opt-axes').checked);
  viewer.setAutoRotate($('opt-spin').checked);

  const mode = doc.view?.mode || (doc.kind === 'mesh' ? 'solid' : 'height');
  setSegActive(mode);

  const mult = doc.view?.size ?? 1;
  ui.pointSize.value = (mult * 1.4).toFixed(1);
  ui.pointSizeV.textContent = (mult * 1.4).toFixed(1);

  updateSpecimen(doc);
  renderTabs();

  ui.empty.classList.toggle('is-hidden', docs.length > 0);
  ui.scalebar.classList.add('is-on');

  if (!opts.silent) {
    runScanline();
    viewer.playReveal();
    if (doc.note) toast(doc.note);
  }
}

function closeDoc(id) {
  const i = docs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [doc] = docs.splice(i, 1);
  const wasActive = active === doc;
  viewer.removeDoc(doc);

  if (wasActive) {
    const next = docs[i] || docs[i - 1] || demoDoc;
    activate(next, { silent: true });
  } else {
    renderTabs();
  }
}

/** 一次拖进来的文件可能分属不同文档；贴图/MTL 归到同名主文件 */
function groupFiles(files) {
  const mains = files.filter((f) => isSupported(f.name));
  if (!mains.length) return [{ files }];

  const stemOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
  const groups = mains.map((f) => ({ main: f, files: [f] }));

  for (const f of files) {
    if (isSupported(f.name)) continue;
    let g = groups.find((x) => stemOf(x.main.name) === stemOf(f.name));
    if (!g && groups.length === 1) g = groups[0];
    if (g) g.files.push(f);
  }
  return groups;
}

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  // 连点两次会并发跑两轮，后面的把前面没跑完的丢掉
  const sid = ++session;
  const groups = groupFiles(files);

  for (const g of groups) {
    if (sid !== session) return;
    const main = g.main || g.files.find((f) => isSupported(f.name)) || g.files[0];
    const big = main.size > 24 * 1024 * 1024;
    const ctx = {
      manager: makeManager(g.files),
      renderer: viewer.renderer,
      onProgress: (p, label) => {
        if (big) toast(`${label} ${Math.round(p * 100)}% · ${main.name}`, false, true);
      },
    };

    if (big) toast(`正在读取 ${main.name}（${formatBytes(main.size)}）…`, false, true);

    try {
      const result = await loadFiles(g.files, ctx);
      if (sid !== session) return;

      const doc = makeDoc(result);
      docs.push(doc);
      while (docs.length > MAX_TABS) {
        const old = docs.shift();
        if (old !== doc) viewer.removeDoc(old);
      }
      activate(doc);
    } catch (err) {
      console.error(err);
      if (sid === session) toast(err?.message || `${main.name} 打不开`, true);
    } finally {
      ctx.manager?.disposeUrls?.();
    }
  }
}

async function openSample(name, label) {
  try {
    // 相对页面地址解析，保证挂在子路径下也能取到
    const res = await fetch(new URL(`samples/${name}`, document.baseURI).href);
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
    (ui.viewport || ui.stage).appendChild(el);
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
  const base = (current?.name || 'show3d').replace(/\.[^.]+$/, '');
  viewer.screenshot(`${base}.png`);
  toast('已保存截图');
});

/* 标签栏 */
ui.tabList.addEventListener('click', (e) => {
  const closer = e.target.closest('[data-close]');
  if (closer) {
    closeDoc(Number(closer.dataset.close));
    return;
  }
  const hit = e.target.closest('[data-id]');
  if (!hit) return;
  const doc = docs.find((d) => d.id === Number(hit.dataset.id));
  if (doc && doc !== active) activate(doc, { silent: true });
});

ui.tabAdd.addEventListener('click', () => ui.fileInput.click());

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
demoDoc = makeDoc({ ...buildDemoSite(), formatLabel: '示例', fileName: '示例场地', elapsed: 0 });
activate(demoDoc, { silent: true });
ui.empty.classList.remove('is-hidden');

// 首屏给一次显影
setTimeout(() => viewer.playReveal(), 160);
