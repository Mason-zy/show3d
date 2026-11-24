/**
 * 位姿解析自检：把真实文件喂给 posesLoader，看认出多少站位、怎么分组。
 * 用法：node tools/probe-poses.mjs <file...>
 */
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { posesLoader } from '../src/loaders/poses.js';

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('用法: node tools/probe-poses.mjs <file...>');
  process.exit(1);
}

const fakes = [];
for (const p of paths) {
  const info = await stat(p);
  fakes.push({
    name: basename(p),
    size: info.size,
    text: () => readFile(p, 'utf8'),
  });
}

const res = await posesLoader.load(fakes, fakes[0], {});
const group = res.object3d;

console.log('文件    ', fakes.map((f) => f.name).join(' + '));
console.log('说明    ', res.note);

const dots = group.children.find((o) => o.isPoints);
const pos = dots.geometry.getAttribute('position');
console.log('站位    ', pos.count);

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const o of group.children) {
  const attr = o.geometry?.getAttribute('position');
  if (!attr) continue;
  for (let i = 0; i < attr.array.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (attr.array[i + k] < min[k]) min[k] = attr.array[i + k];
      if (attr.array[i + k] > max[k]) max[k] = attr.array[i + k];
    }
  }
}
console.log(
  '范围    ',
  ['x', 'y', 'z'].map((k, i) => `${k} ${min[i].toFixed(2)} … ${max[i].toFixed(2)}`).join('   ')
);

const lines = group.children.filter((o) => o.isLineSegments);
console.log(
  '线段    ',
  `路径 ${lines[0] ? lines[0].geometry.getAttribute('position').count / 2 : 0}`,
  `朝向 ${lines[1] ? lines[1].geometry.getAttribute('position').count / 2 : 0}`
);
