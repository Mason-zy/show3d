import './style.css';
import * as THREE from 'three';
import { Viewer, fmtNum } from './core/viewer.js';
import { loadFiles, ACCEPT, formatList, isSupported } from './loaders/registry.js';
import { buildDemoSite } from './loaders/demo.js';
import { makeManager, applyPointScale } from './loaders/util.js';
import { posesLoader } from './loaders/poses.js';
import { SOURCE_COLORS } from './core/colors.js';

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
  specSourcesRow: $('spec-sources-row'),
  specSources: $('spec-sources'),
  btnOverlay: $('btn-overlay'),
  groupLayers: $('group-layers'),
  layersCount: $('layers-count'),
  layerList: $('layer-list'),
  pointSize: $('point-size'),
  pointSizeV: $('point-size-v'),
  pointsNote: $('points-note'),
  seg: document.querySelector('.seg'),
  popover: $('formats-popover'),
  formatList: $('format-list'),
  samples: $('samples'),
};

const viewer = new Viewer($('view'));

// ?debug 会在线上也挂上这个钩子，方便直接查场景状态
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  window.__show3d = {
    viewer,
    get content() {
      return current;
    },
    get docs() {
      return docs;
    },
  };
}

let current = null;
let toastTimer = 0;
let dragDepth = 0;
let session = 0;
let overlayMode = false;

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
  if (!isFinite(center.x + center.y + center.z)) return { box, center: new THREE.Vector3() };

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
  return { box: new THREE.Box3().setFromObject(object3d), center };
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
    return { box: new THREE.Box3().setFromObject(object3d), center };
  }

  if (kind === 'cloud' || kind === 'both') {
    return centerCloud(object3d);
  }

  object3d.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object3d);
  const center = box.getCenter(new THREE.Vector3());
  object3d.position.sub(center);
  object3d.updateMatrixWorld(true);
  return { box: new THREE.Box3().setFromObject(object3d), center };
}

/** 来源类型的中文名，图层列表里显示 */
const KIND_LABEL = { cloud: '点云', mesh: '网格', trajectory: '轨迹', both: '点云' };

/** 侧栏图层列表：一行一个来源，勾选框就是显示/隐藏 */
function renderLayers(doc) {
  const layers = doc?.layers || [];
  ui.groupLayers.hidden = layers.length === 0;
  ui.layersCount.textContent = layers.length > 1 ? `${layers.length} 个` : '';
  ui.layerList.innerHTML = layers
    .map((l, i) => {
      const color = `#${SOURCE_COLORS[i % SOURCE_COLORS.length].toString(16).padStart(6, '0')}`;
      return `<li class="layer">
        <label class="layer-row" title="${esc(l.name)}">
          <input type="checkbox" data-layer="${i}" ${l.object3d.visible ? 'checked' : ''} />
          <span class="layer-dot" style="--c:${color}"></span>
          <span class="layer-name">${esc(l.name)}</span>
          <span class="layer-kind">${esc(KIND_LABEL[l.kind] || l.kind || '')}</span>
        </label>
      </li>`;
    })
    .join('');
}

/** 统计一份对象里有哪些可选着色数据 */
function scanAttributes(root) {
  let hasIntensity = false;
  let hasClasses = false;
  root.traverse((o) => {
    if (!o.isPoints) return;
    if (o.userData.intensity) hasIntensity = true;
    if (o.userData.classes) hasClasses = true;
  });
  return { hasIntensity, hasClasses };
}

function makeDoc(result) {
  const { box, center } = normalize(result);

  // 文档根节点是空容器，每个文件都是它的子节点。
  // 这样"隐藏第一个图层"只隐藏那个文件，不会连叠加进来的对象一起干掉。
  const root = new THREE.Group();
  root.add(result.object3d);
  const pointBase = applyPointScale(root);
  const stats = viewer.statsOf(root);
  const { hasIntensity, hasClasses } = scanAttributes(root);

  // 叠加时按来源分色，第一个来源就是 0 号
  root.traverse((o) => {
    if (o.userData.sourceIndex === undefined) o.userData.sourceIndex = 0;
  });

  return {
    id: ++docSeq,
    name: result.fileName || '示例',
    formatLabel: result.formatLabel || '示例',
    fileSize: result.fileSize || 0,
    elapsed: result.elapsed || 0,
    note: result.note,
    units: result.units || null,
    kind: result.kind,
    object3d: root,
    box,
    center,
    stats,
    hasIntensity,
    hasClasses,
    pointBase,
    sources: 1,
    layers: [
      {
        name: result.fileName || '示例',
        object3d: result.object3d,
        kind: result.kind,
      },
    ],
    view: null,
    prepared: false,
    colorMode: result.kind === 'mesh' || result.kind === 'trajectory' ? 'solid' : 'height',
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

  ui.specSourcesRow.hidden = (doc.layers?.length || 0) < 2;
  ui.specSources.textContent = `${doc.layers?.length || 0} 个`;

  ui.roPoints.textContent = fmtNum(doc.stats.points);
  ui.roTris.textContent = fmtNum(doc.stats.triangles);

  const isCloud = doc.kind === 'cloud' || doc.kind === 'both';
  ui.pointSize.disabled = !isCloud;
  ui.pointsNote.textContent = isCloud
    ? '越大越接近实景，越小越省性能'
    : doc.kind === 'trajectory'
      ? '轨迹站点固定大小'
      : '当前是网格模型';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderTabs() {
  ui.tabs.hidden = docs.length === 0;
  ui.tabList.innerHTML = docs
    .map((d) => {
      const layers = d.layers || [];
      const extra = layers.length > 1 ? `<span class="tab-count">+${layers.length - 1}</span>` : '';
      const title = layers.length > 1 ? layers.map((l) => l.name).join('\n') : d.name;
      return `<div class="tab${d === active ? ' is-on' : ''}" data-id="${d.id}" draggable="true">
        <button class="tab-main" data-id="${d.id}" title="${esc(title)}">
          <span class="tab-name">${esc(d.name)}</span>${extra}
        </button>
        <button class="tab-x" data-close="${d.id}" title="关闭">×</button>
      </div>`;
    })
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

  const mode =
    doc.view?.mode ||
    doc.colorMode ||
    (doc.kind === 'mesh' || doc.kind === 'trajectory' ? 'solid' : 'height');

  const intenBtn = ui.seg.querySelector('[data-color="intensity"]');
  if (intenBtn) intenBtn.hidden = !doc.hasIntensity;
  const classBtn = ui.seg.querySelector('[data-color="class"]');
  if (classBtn) classBtn.hidden = !doc.hasClasses;
  const sourceBtn = ui.seg.querySelector('[data-color="source"]');
  if (sourceBtn) sourceBtn.hidden = (doc.sources || 1) < 2;
  setSegActive(mode);

  const mult = doc.view?.size ?? 1;
  ui.pointSize.value = (mult * 1.4).toFixed(1);
  ui.pointSizeV.textContent = (mult * 1.4).toFixed(1);

  updateSpecimen(doc);
  renderLayers(doc);
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

/** .json 既可能是位姿表，也可能是配置；只看名字不够，得瞟一眼内容 */
async function looksLikePoseJson(file) {
  const head = await file.slice(0, 16384).text();
  return (
    /"(sensor_pose|stations|poses|trajectory|frames)"\s*:/.test(head) ||
    (/"(pos|position)"\s*:\s*\[/.test(head) && /"(yaw|pitch|heading|elevation)"/.test(head))
  );
}

/** 位姿文件不占标签页，而是叠到点云上，所以先单独挑出来 */
async function splitPoseFiles(files) {
  const poseFiles = [];
  const otherFiles = [];
  for (const f of files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.jsonl')) {
      poseFiles.push(f);
      continue;
    }
    if (n.endsWith('.json')) {
      try {
        if (await looksLikePoseJson(f)) {
          poseFiles.push(f);
          continue;
        }
      } catch {
        /* 读不出来就当普通文件 */
      }
    }
    otherFiles.push(f);
  }
  return { poseFiles, otherFiles };
}

/** 走和 loadFiles 同一套形状的返回，方便 makeDoc 直接吃 */
async function loadPoseDoc(files) {
  const t0 = performance.now();
  const ctx = { manager: makeManager(files), renderer: viewer.renderer };
  const res = await posesLoader.load(files, files[0], ctx);
  return {
    ...res,
    elapsed: performance.now() - t0,
    formatLabel: posesLoader.label,
    fileName: files.map((f) => f.name).join(' + '),
    fileSize: files.reduce((s, f) => s + f.size, 0),
  };
}

/**
 * 把子对象摆到文档原点（-center）。
 * 注意：点云的居中是改几何体、根节点留在原点；网格和轨迹的居中是把
 * 根节点挪到 -center。所以子对象不能直接减 center，必须换算到父节点的
 * 局部坐标，否则叠在网格/轨迹上的对象会被平移两遍。
 */
function placeAtDocOrigin(child, doc) {
  const target = new THREE.Vector3(-doc.center.x, -doc.center.y, -doc.center.z);
  doc.object3d.updateMatrixWorld(true);
  child.position.copy(target);
  doc.object3d.worldToLocal(child.position);
}

/** 把位姿轨迹作为一个图层挂到文档上 */
function attachTrajectory(doc, posesObject) {
  placeAtDocOrigin(posesObject, doc);
  doc.object3d.add(posesObject);
  doc.layers.push({ name: '位姿轨迹', object3d: posesObject, kind: 'trajectory' });
  doc.box = new THREE.Box3().setFromObject(doc.object3d);
  doc.stats = viewer.statsOf(doc.object3d);
}

/**
 * 叠加：把新对象挂到已有文档上，共用第一个文件的坐标原点。
 * 各来源之间的相对位置保持不变，所以两个点云对得上。
 */
function addOverlay(doc, result, name) {
  const obj = result.object3d;
  if ((result.upAxis || 'z') === 'y') obj.rotation.x += Math.PI / 2;
  placeAtDocOrigin(obj, doc);
  obj.updateMatrixWorld(true);

  const idx = doc.sources;
  obj.traverse((o) => {
    if (o.userData.sourceIndex === undefined) o.userData.sourceIndex = idx;
  });
  doc.object3d.add(obj);
  doc.sources += 1;
  doc.layers.push({ name, object3d: obj, kind: result.kind });

  viewer._prepareMaterials(obj);
  doc.pointBase = applyPointScale(doc.object3d);

  doc.box = new THREE.Box3().setFromObject(doc.object3d);
  doc.stats = viewer.statsOf(doc.object3d);
  const attrs = scanAttributes(doc.object3d);
  doc.hasIntensity = attrs.hasIntensity;
  doc.hasClasses = attrs.hasClasses;
  doc.fileSize += result.fileSize || 0;
  doc.elapsed += result.elapsed || 0;

  // 第一次叠加重新取景（新数据可能远得多），之后保持当前视角，免得每次拖都跳
  if (doc.sources === 2) {
    doc.view = null;
    doc.colorMode = 'source';
  }
  doc.note = `已叠加 ${doc.layers.length} 个对象`;
}

async function openFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  // 连点两次会并发跑两轮，后面的把前面没跑完的丢掉
  const sid = ++session;

  const { poseFiles, otherFiles } = await splitPoseFiles(files);
  if (sid !== session) return;
  const groups = otherFiles.length ? groupFiles(otherFiles) : [];

  // 轨迹先解析好，等主文件建完再叠上去（两边的世界坐标要共用一个原点）
  let posesObject = null;
  let posesNote = '';
  if (poseFiles.length) {
    try {
      const r = await loadPoseDoc(poseFiles);
      if (sid !== session) return;
      if (!groups.length) {
        // 只拖了轨迹文件：已经在看某个场景就叠上去，否则单独开一个标签
        const target = active && docs.includes(active) ? active : null;
        if (target) {
          attachTrajectory(target, r.object3d);
          activate(target, { silent: true });
          toast(`轨迹已叠加到当前场景（${r.note || '位姿轨迹'}）`);
          return;
        }
        const doc = makeDoc(r);
        docs.push(doc);
        activate(doc);
        return;
      }
      posesObject = r.object3d;
      posesNote = r.note || '';
    } catch (err) {
      console.error(err);
      toast(`轨迹没读出来：${err.message}`, true);
    }
  }

  let overlaid = false;

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
      hideToast();
      if (sid !== session) return;

      // 叠加模式：挂到当前文档上，不新建标签（示例场地不算，它只是个占位）
      if (overlayMode && active && docs.includes(active)) {
        addOverlay(active, result, main.name);

        if (posesObject && !overlaid) {
          attachTrajectory(active, posesObject);
          overlaid = true;
        }

        activate(active, { silent: true });
        toast(`已叠加 ${main.name}（共 ${active.layers.length} 个对象）`);
        continue;
      }

      const doc = makeDoc(result);

      // 轨迹叠到第一个 Z 朝上的主文件上
      if (posesObject && !overlaid && result.upAxis !== 'y') {
        attachTrajectory(doc, posesObject);
        const tag = posesNote ? `轨迹已叠加（${posesNote}）` : '轨迹已叠加';
        doc.note = doc.note ? `${doc.note} · ${tag}` : tag;
        overlaid = true;
      }

      docs.push(doc);
      while (docs.length > MAX_TABS) {
        const old = docs.shift();
        if (old !== doc) viewer.removeDoc(old);
      }
      activate(doc);
    } catch (err) {
      console.error(err);
      hideToast();
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

function hideToast() {
  clearTimeout(toastTimer);
  ui.toast.classList.remove('is-on');
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

/* 拖动标签调整顺序 */
let dragTabId = null;
let dropHintEl = null;

function clearDropHint() {
  if (dropHintEl) dropHintEl.classList.remove('drop-before', 'drop-after');
  dropHintEl = null;
}

/** 找鼠标落在哪个标签的前/后半区 */
function dropTarget(clientX) {
  const tabs = [...ui.tabList.querySelectorAll('.tab')];
  for (const el of tabs) {
    const r = el.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return { el, beforeId: Number(el.dataset.id) };
  }
  const last = tabs[tabs.length - 1];
  return { el: last, beforeId: null };
}

ui.tabList.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  dragTabId = Number(tab.dataset.id);
  tab.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragTabId));
});

ui.tabList.addEventListener('dragend', () => {
  dragTabId = null;
  clearDropHint();
  ui.tabList.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-dragging'));
});

ui.tabList.addEventListener('dragover', (e) => {
  if (dragTabId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const { el, beforeId } = dropTarget(e.clientX);
  if (el === dropHintEl) return;
  clearDropHint();
  if (!el) return;
  el.classList.add(beforeId == null ? 'drop-after' : 'drop-before');
  dropHintEl = el;
});

ui.tabList.addEventListener('drop', (e) => {
  if (dragTabId == null) return;
  e.preventDefault();
  e.stopPropagation();
  const { beforeId } = dropTarget(e.clientX);
  reorderTabs(dragTabId, beforeId);
  clearDropHint();
  dragTabId = null;
  renderTabs();
});

function reorderTabs(id, beforeId) {
  const from = docs.findIndex((d) => d.id === id);
  if (from < 0) return;
  const [doc] = docs.splice(from, 1);
  let to = beforeId == null ? docs.length : docs.findIndex((d) => d.id === beforeId);
  if (to < 0) to = docs.length;
  docs.splice(to, 0, doc);
}

/* 收起 / 展开侧栏，把整块让给视口 */
$('btn-rail').addEventListener('click', () => {
  const btn = $('btn-rail');
  const hidden = $('body').classList.toggle('rail-hidden');
  btn.classList.toggle('is-off', hidden);
  btn.title = hidden ? '展开侧栏' : '收起侧栏';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-expanded', String(!hidden));
});

$('btn-frame').addEventListener('click', () => viewer.frameContent());
$('view').addEventListener('dblclick', () => viewer.frameContent());

/* 叠加模式：新打开的文件挂到当前场景上 */
ui.btnOverlay.addEventListener('click', () => {
  overlayMode = !overlayMode;
  const btn = ui.btnOverlay;
  btn.classList.toggle('is-on', overlayMode);
  btn.setAttribute('aria-pressed', String(overlayMode));
  btn.title = overlayMode
    ? '新打开的文件叠到当前场景，不新建标签（再点一次关闭）'
    : '打开的文件叠到当前场景，不新建标签';
  toast(
    overlayMode
      ? '叠加模式：新打开的文件会挂到当前场景上'
      : '已退出叠加模式，新文件各自开标签',
    false,
    false
  );
});

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

/* 图层显隐 */
ui.layerList.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-layer]');
  if (!input || !active) return;
  const layer = active.layers?.[Number(input.dataset.layer)];
  if (!layer) return;
  layer.object3d.visible = input.checked;
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

/** 只接文件，标签拖动不算 */
function hasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

ui.stage.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  showVeil(true);
});
ui.stage.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
ui.stage.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    showVeil(false);
  }
});
ui.stage.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showVeil(false);
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
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
