/**
 * 配色。点云的高度色带是这个工具的"体温"，
 * 从深普鲁士到信号红，和界面同源。
 */

const STOPS = [
  [0.0, 0x12, 0x3a, 0x5c],
  [0.2, 0x1f, 0x6d, 0x8f],
  [0.42, 0x2f, 0x9d, 0x8b],
  [0.64, 0x96, 0xbf, 0x5f],
  [0.84, 0xe6, 0xcf, 0x72],
  [1.0, 0xc6, 0x3a, 0x2e],
];

/* three 的顶点色按线性空间解释，而色带是按 sRGB 写的，
   必须在写入前转一次，否则整体会被提亮成灰白。 */
const LUT_N = 1024;
const LIN = new Float32Array(LUT_N);
for (let i = 0; i < LUT_N; i++) {
  const c = i / (LUT_N - 1);
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function lin(c) {
  let i = (c * (LUT_N - 1)) | 0;
  if (i < 0) i = 0;
  else if (i > LUT_N - 1) i = LUT_N - 1;
  return LIN[i];
}

/** 分类色板：LAS 类别 0–20，克制的低饱和 */
const CLASS_COLORS = [
  0x8b9691, // 0 未分类
  0x3c4f5c, // 1 未分配
  0x4a6f52, // 2 地面
  0x6b8a4e, // 3 低植被
  0x86a35c, // 4 中植被
  0x5d7d3f, // 5 高植被
  0x6f6a60, // 6 建筑
  0x8a5b52, // 7 噪点
  0x9aa5a0, // 8 模型关键点
  0x2f7f9d, // 9 水体
  0x5b6b7a, // 10 铁路
  0x7a8a94, // 11 路面
  0x9d9a8c, // 12 重叠
  0xa8a49a, // 13 线护
  0x8f9aa2, // 14 导线
  0x6d7f8c, // 15 塔
  0x7f8f77, // 16 连接线
  0x9b8f8a, // 17 桥
  0x86867f, // 18 高噪点
  0x6c7a84, // 19
  0x8a8f96, // 20
];

export function rampColor(t, out) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const k = (t - a[0]) / (b[0] - a[0] || 1);
      out[0] = lin((a[1] + (b[1] - a[1]) * k) / 255);
      out[1] = lin((a[2] + (b[2] - a[2]) * k) / 255);
      out[2] = lin((a[3] + (b[3] - a[3]) * k) / 255);
      return out;
    }
  }
  const z = STOPS[STOPS.length - 1];
  out[0] = lin(z[1] / 255);
  out[1] = lin(z[2] / 255);
  out[2] = lin(z[3] / 255);
  return out;
}

export function classColor(id) {
  const hex = CLASS_COLORS[id] ?? 0x8b9691;
  return [lin(((hex >> 16) & 255) / 255), lin(((hex >> 8) & 255) / 255), lin((hex & 255) / 255)];
}

/**
 * 按高度生成顶点色，返回 Float32Array（rgb, rgb, …）
 * 世界坐标是 Z 朝上，所以高度取 z 分量。
 */
export function heightRamp(positions, count, zMin, zMax, target) {
  const out = target || new Float32Array(count * 3);
  const tmp = [0, 0, 0];
  const span = zMax - zMin || 1;
  for (let i = 0; i < count; i++) {
    rampColor((positions[i * 3 + 2] - zMin) / span, tmp);
    out[i * 3] = tmp[0];
    out[i * 3 + 1] = tmp[1];
    out[i * 3 + 2] = tmp[2];
  }
  return out;
}

export function classRamp(classes, count, target) {
  const out = target || new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const c = classColor(classes[i]);
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

export function uniformColor(hex, count, target) {
  const out = target || new Float32Array(count * 3);
  const r = lin(((hex >> 16) & 255) / 255);
  const g = lin(((hex >> 8) & 255) / 255);
  const b = lin((hex & 255) / 255);
  for (let i = 0; i < count; i++) {
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/**
 * 回波强度 → 灰度。扫描仪的原生观感。
 * 用直方图砍掉两头 0.5% 的极值，否则一个异常值就能把整个色阶压平。
 */
export function intensityRamp(values, count, target) {
  const out = target || new Float32Array(count * 3);
  if (!count) return out;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo) || !(hi > lo)) {
    const g = lin(0.45);
    out.fill(0);
    for (let i = 0; i < count; i++) {
      out[i * 3] = g;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = g;
    }
    return out;
  }

  const BINS = 256;
  const hist = new Uint32Array(BINS);
  const span = hi - lo;
  for (let i = 0; i < count; i++) {
    let b = (((values[i] - lo) / span) * (BINS - 1)) | 0;
    if (b < 0) b = 0;
    else if (b > BINS - 1) b = BINS - 1;
    hist[b]++;
  }

  let acc = 0;
  let bLo = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= count * 0.005) {
      bLo = b;
      break;
    }
  }
  acc = 0;
  let bHi = BINS - 1;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= count * 0.995) {
      bHi = b;
      break;
    }
  }
  if (bHi <= bLo) {
    bLo = 0;
    bHi = BINS - 1;
  }

  const vLo = lo + (bLo / (BINS - 1)) * span;
  const d = (lo + (bHi / (BINS - 1)) * span - vLo) || 1;

  for (let i = 0; i < count; i++) {
    let t = (values[i] - vLo) / d;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const g = lin(Math.sqrt(t)); // 提一点暗部
    out[i * 3] = g;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = g;
  }
  return out;
}

export const SOLID_CHROME = 0x3f5668;
export const SOLID_MESH = 0x7f919c;
