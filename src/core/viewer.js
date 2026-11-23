import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { heightRamp, classRamp, uniformColor, SOLID_CHROME, SOLID_MESH } from './colors.js';

const DEG = Math.PI / 180;

// 测绘/点云数据是 Z 轴朝上，整个世界坐标系按 Z 上走，
// 底部读数才能和文件里的坐标对得上。
const WORLD_UP = new THREE.Vector3(0, 0, 1);
THREE.Object3D.DEFAULT_UP.copy(WORLD_UP);

function niceNumber(v) {
  if (!isFinite(v) || v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * mag;
}

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function fmtLength(v) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return `${(v / 1000).toFixed(2)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearAlpha(0);
    // 这是量测工具，颜色要照实显示，不做电影感色调映射
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 5000);
    this.camera.up.copy(WORLD_UP);
    this.camera.position.set(14, -16, 12);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.8;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.minDistance = 0.001;
    this.controls.maxDistance = 1e7;

    // 环境反射：glTF 的金属材质没有环境贴图就是一团黑，
    // 用程序生成一个室内环境当反射源，顺带让塑料/金属都有正常的形体。
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
    this.scene.environmentIntensity = 0.6;

    // 光照：半球打底 + 一盏侧上光，浅色场景里靠这个撑形体
    const hemi = new THREE.HemisphereLight(0xffffff, 0xa3b0aa, 1.25);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(9, -16, 12);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe9f2, 0.4);
    fill.position.set(-10, 6, -8);
    this.scene.add(fill);

    this.gridGroup = new THREE.Group();
    this.scene.add(this.gridGroup);

    this.contentGroup = new THREE.Group();
    this.scene.add(this.contentGroup);

    this.content = null;
    this._last = performance.now();
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._scaleTick = 0;

    this.onFrame = null;
    this.onScale = null;
    this.onCursor = null;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._plane = new THREE.Plane();
    this._hit = new THREE.Vector3();
    this._dir = new THREE.Vector3();

    this._reveal = null;

    this._bindPointer();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas.parentElement || canvas);

    this._animate = this._animate.bind(this);
    this.renderer.setAnimationLoop(this._animate);
  }

  get sizePx() {
    const el = this.canvas.parentElement || this.canvas;
    return { w: el.clientWidth, h: el.clientHeight };
  }

  _resize() {
    const { w, h } = this.sizePx;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _bindPointer() {
    this._onMove = (e) => {
      if (!this.content) return;
      const rect = this.canvas.getBoundingClientRect();
      this._ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this._ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this._raycaster.setFromCamera(this._ndc, this.camera);
      this.camera.getWorldDirection(this._dir);
      this._plane.setFromNormalAndCoplanarPoint(this._dir, this.controls.target);
      if (this._raycaster.ray.intersectPlane(this._plane, this._hit) && this.onCursor) {
        this.onCursor(this._hit);
      }
    };
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerleave', () => this.onCursor && this.onCursor(null));
  }

  _animate() {
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.25);
    this._last = now;

    this.controls.update();

    // 载入后的显影动画
    if (this._reveal) {
      const t = Math.min(1, (performance.now() - this._reveal.start) / 460);
      const e = 1 - Math.pow(1 - t, 3);
      this._reveal.apply(e);
      if (t >= 1) {
        this._reveal.finish();
        this._reveal = null;
      }
    }

    this.renderer.render(this.scene, this.camera);

    // 帧率
    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      if (this.onFrame) this.onFrame(Math.round(this._fpsFrames / this._fpsAcc));
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }

    // 比例尺（每 6 帧算一次就够）
    if (++this._scaleTick % 6 === 0) this._updateScale();
  }

  _updateScale() {
    if (!this.onScale) return;
    const { h } = this.sizePx;
    if (!h) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const worldH = 2 * Math.tan((this.camera.fov * DEG) / 2) * dist;
    const worldPerPx = worldH / h;
    const want = worldPerPx * 120;
    const len = niceNumber(want);
    const px = len / worldPerPx;
    this.onScale({ len, px, unit: this.content?.units || null });
  }

  /**
   * 切换到一个文档。上一个文档只是从场景里摘下来，不销毁，
   * 所以来回切标签不用重新解析；每个文档还记得自己的相机和着色。
   */
  show(doc) {
    if (this.content && this.content !== doc) this._saveView(this.content);

    if (this.content && this.content.object3d.parent === this.contentGroup) {
      this.contentGroup.remove(this.content.object3d);
    }

    this.content = doc;
    this.contentGroup.add(doc.object3d);

    if (!doc.prepared) {
      this._prepareMaterials(doc.object3d);
      doc.prepared = true;
    }

    this._pointBase = doc.pointBase || 0;

    if (doc.view) {
      this.camera.position.copy(doc.view.pos);
      this.controls.target.copy(doc.view.target);
      this._updateClip();
      this.controls.update();
      this._buildGrid();
      this.setColorMode(doc.view.mode);
      this.setPointSize(doc.view.size);
    } else {
      this._frame();
      this._buildGrid();
      this.setColorMode(doc.kind === 'mesh' ? 'solid' : 'height');
      this.setPointSize(1);
    }
  }

  _saveView(doc) {
    doc.view = {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      mode: doc.colorMode || 'height',
      size: this._sizeMult || 1,
    };
  }

  _updateClip() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const radius = Math.max(dist, 1e-4);
    this.camera.near = Math.max(dist * 0.002, 1e-5);
    this.camera.far = dist * 60 + radius * 6;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.max(dist * 0.002, 1e-5);
    this.controls.maxDistance = dist * 30;
  }

  /** 关掉一个文档并释放显存 */
  removeDoc(doc) {
    if (!doc) return;
    if (this.content === doc) {
      this.contentGroup.remove(doc.object3d);
      this.content = null;
    }
    this._disposeObject(doc.object3d);
  }

  /** 清空当前视图（不销毁文档，文档由调用方管理） */
  detach() {
    if (this.content && this.content.object3d.parent === this.contentGroup) {
      this.contentGroup.remove(this.content.object3d);
    }
    this.content = null;
    this.gridGroup.clear();
    this.axesGroup = null;
  }

  _prepareMaterials(root) {
    root.traverse((o) => {
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        if (!g.userData._origColor) {
          const attr = g.getAttribute('color');
          g.userData._origColor = attr ? attr.array.slice() : null;
          g.userData._count = g.getAttribute('position')?.count || 0;
        }
        o.material = o.material.clone();
      } else if (o.isPoints && o.geometry) {
        o.material = o.material.clone();
      }
    });
  }

  _frame() {
    const box = this.content.box;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-6);
    const dir = new THREE.Vector3(0.62, -0.72, 0.58).normalize();

    // 把包围盒 8 个角投到相机平面上，按真实的横向/纵向张角取距离，
    // 否则扁平点云会被包围球算得过远，缩成一条带子。
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, WORLD_UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

    const { min, max } = box;
    const corner = new THREE.Vector3();
    let hMax = 0;
    let vMax = 0;
    let dMax = 0;
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
        .sub(center);
      hMax = Math.max(hMax, Math.abs(corner.dot(right)));
      vMax = Math.max(vMax, Math.abs(corner.dot(up)));
      dMax = Math.max(dMax, Math.abs(corner.dot(fwd)));
    }

    const tanV = Math.tan((this.camera.fov * DEG) / 2);
    const tanH = tanV * this.camera.aspect;
    const dist = Math.max(hMax / tanH, vMax / tanV) * 1.16 + dMax;

    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist * 0.002, 1e-5);
    this.camera.far = dist * 60 + radius * 6;
    this.camera.updateProjectionMatrix();

    this.controls.target.copy(center);
    this.controls.minDistance = Math.max(radius * 0.004, 1e-5);
    this.controls.maxDistance = dist * 30;
    this.controls.update();
  }

  _buildGrid() {
    this.gridGroup.clear();
    const box = this.content?.box;
    if (!box || box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z, size.y, 1e-4);
    const cell = niceNumber(maxDim / 10);
    const divisions = 20;
    const span = cell * divisions;

    const grid = new THREE.GridHelper(span, divisions, 0xa9b5af, 0xc2ccc7);
    grid.material.transparent = true;
    grid.material.opacity = 0.9;
    // GridHelper 默认铺在 XZ 平面，Z 上坐标系要转到 XY 平面
    grid.rotation.x = Math.PI / 2;
    grid.position.set(
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      box.min.z
    );
    this.gridGroup.add(grid);

    // 坐标轴落在模型底面中心
    const axes = new THREE.Group();
    const L = cell * 1.6;
    const mk = (a, b, color) => {
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    };
    const o = new THREE.Vector3(0, 0, 0);
    axes.add(mk(o, new THREE.Vector3(L, 0, 0), 0xa8443a)); // X
    axes.add(mk(o, new THREE.Vector3(0, L, 0), 0x3f7a5c)); // Y
    axes.add(mk(o, new THREE.Vector3(0, 0, L), 0x2f5f8a)); // Z
    axes.position.copy(grid.position);
    this.gridGroup.add(axes);
    this.axesGroup = axes;
  }

  setGrid(on) {
    if (this.gridGroup.children[0]) this.gridGroup.children[0].visible = on;
  }

  setAxes(on) {
    if (this.axesGroup) this.axesGroup.visible = on;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  setPointSize(mult) {
    this._sizeMult = mult;
    this.contentGroup.traverse((o) => {
      if (o.isPoints && o.material) {
        const base = this._pointBase || 1;
        o.material.size = base * mult;
      }
    });
  }

  setWireframe(on) {
    this.contentGroup.traverse((o) => {
      if (o.isMesh && o.material && 'wireframe' in o.material) {
        o.material.wireframe = on;
      }
    });
  }

  setColorMode(mode) {
    if (!this.content) return;
    this.content.colorMode = mode;
    const box = this.content.box;
    const yMin = box.min.z;
    const yMax = box.max.z;

    this.contentGroup.traverse((o) => {
      if (o.isPoints) {
        const geo = o.geometry;
        const pos = geo.getAttribute('position');
        if (!pos) return;
        const count = pos.count;

        // 复用同一块顶点色缓冲：千万点每次切换都重新分配会直接卡死
        let attr = geo.getAttribute('color');
        let arr;
        if (attr && attr.array.length === count * 3) {
          arr = attr.array;
        } else {
          arr = new Float32Array(count * 3);
          attr = new THREE.BufferAttribute(arr, 3);
          geo.setAttribute('color', attr);
        }

        if (mode === 'class' && o.userData.classes) {
          classRamp(o.userData.classes, count, arr);
        } else if (mode === 'rgb' && o.userData.colors) {
          arr.set(o.userData.colors);
        } else if (mode === 'solid') {
          uniformColor(SOLID_CHROME, count, arr);
        } else {
          heightRamp(pos.array, count, yMin, yMax, arr);
        }

        attr.needsUpdate = true;
        o.material.vertexColors = true;
        o.material.color.set(0xffffff);
        o.material.needsUpdate = true;
        if (!this._pointBase) this._pointBase = o.material.size;
      } else if (o.isMesh) {
        const geo = o.geometry;
        if (!geo) return;
        const pos = geo.getAttribute('position');
        if (!pos) return;
        const count = pos.count;

        if (mode === 'solid') {
          o.material.vertexColors = false;
          o.material.color.set(SOLID_MESH);
          o.material.needsUpdate = true;
          return;
        }

        let arr = geo.getAttribute('color')?.array;
        if (!arr || arr.length !== count * 3) {
          arr = new Float32Array(count * 3);
          geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        }

        if (mode === 'rgb' && geo.userData._origColor) {
          arr.set(geo.userData._origColor);
        } else {
          heightRamp(pos.array, count, yMin, yMax, arr);
        }
        geo.getAttribute('color').needsUpdate = true;
        o.material.vertexColors = true;
        o.material.color.set(0xffffff);
        o.material.needsUpdate = true;
      }
    });
  }

  /** 重新取景（双击视口或点"居中"） */
  frameContent() {
    if (!this.content) return;
    this._frame();
  }

  _disposeObject(root) {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        for (const key of Object.keys(m)) {
          const v = m[key];
          if (v && v.isTexture) v.dispose();
        }
        m.dispose();
      }
    });
  }

  /** 载入后的显影：轻微缩放 + 淡入 */
  playReveal() {
    const targets = [];
    this.contentGroup.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (m.transparent && m.opacity < 1) continue;
        m.userData._baseOpacity = m.opacity ?? 1;
        m.transparent = true;
        m.opacity = 0;
        targets.push(m);
      }
    });
    const startScale = this.contentGroup.scale.x;
    this._reveal = {
      start: performance.now(),
      apply: (e) => {
        for (const m of targets) m.opacity = (m.userData._baseOpacity ?? 1) * e;
        const s = startScale * (0.965 + 0.035 * e);
        this.contentGroup.scale.setScalar(s);
      },
      finish: () => {
        for (const m of targets) {
          m.opacity = m.userData._baseOpacity ?? 1;
          m.transparent = false;
          m.needsUpdate = true;
        }
        this.contentGroup.scale.setScalar(startScale);
      },
    };
  }

  screenshot(name = 'show3d.png') {
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }

  statsOf(object3d) {
    let points = 0;
    let triangles = 0;
    object3d.traverse((o) => {
      if (o.isPoints && o.geometry) points += o.geometry.getAttribute('position')?.count || 0;
      if (o.isMesh && o.geometry) {
        const g = o.geometry;
        if (g.index) triangles += g.index.count / 3;
        else triangles += (g.getAttribute('position')?.count || 0) / 3;
      }
    });
    return { points, triangles: Math.floor(triangles) };
  }
}

export { fmtNum, fmtLength };
