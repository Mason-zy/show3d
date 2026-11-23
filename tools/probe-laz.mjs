import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const create = require('../node_modules/laz-perf/lib/node/index.js').createLazPerf;

const buf = fs.readFileSync(process.argv[2]);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offsetToPointData = dv.getUint32(96, true);

const m = await create();
const src = new Uint8Array(buf.buffer, buf.byteOffset);

let t = performance.now();
const laszip = new m.LASZip();
const ptr = m._malloc(src.byteLength);
m.HEAPU8.set(src, ptr);
laszip.open(ptr, src.byteLength);
const count = laszip.getCount();
const plen = laszip.getPointLength();
console.log(`open: ${(performance.now() - t).toFixed(0)} ms, count=${count}, plen=${plen}`);

t = performance.now();
const out = new Uint8Array(count * plen);
const CHUNK = 400000;
const bufPtr = m._malloc(CHUNK * plen);
for (let i = 0; i < count; i += CHUNK) {
  const n = Math.min(CHUNK, count - i);
  for (let k = 0; k < n; k++) laszip.getPoint(bufPtr + k * plen);
  out.set(m.HEAPU8.subarray(bufPtr, bufPtr + n * plen), i * plen);
}
console.log(`decode: ${(performance.now() - t).toFixed(0)} ms  (${((performance.now() - t) / count * 1000).toFixed(2)} µs/pt)`);

t = performance.now();
const rec = new DataView(out.buffer, out.byteOffset, out.byteLength);
const positions = new Float32Array(count * 3);
for (let i = 0; i < count; i++) {
  const o = i * plen;
  positions[i * 3] = rec.getInt32(o, true);
  positions[i * 3 + 1] = rec.getInt32(o + 4, true);
  positions[i * 3 + 2] = rec.getInt32(o + 8, true);
}
console.log(`unpack xyz: ${(performance.now() - t).toFixed(0)} ms`);
