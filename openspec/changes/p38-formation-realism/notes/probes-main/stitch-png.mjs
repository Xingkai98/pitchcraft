// 把多张同尺寸 PNG 横向拼接成一张（无依赖，纯 zlib 手动编解码）。
// 用法：node stitch-png.mjs <out.png> <in1.png> <in2.png> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

function readPng(path) {
  const d = readFileSync(path);
  let i = 8; let w = 0; let h = 0; let ct = 0; let bd = 0; let idat = Buffer.alloc(0);
  while (i < d.length) {
    const ln = d.readUInt32BE(i); const typ = d.toString('ascii', i + 4, i + 8);
    const data = d.subarray(i + 8, i + 8 + ln);
    if (typ === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (typ === 'IDAT') idat = Buffer.concat([idat, data]);
    i += 12 + ln;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`不支持 bd=${bd} ct=${ct}`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = inflateSync(idat);
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0; const b = prev[x]; const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, bpp, px };
}

function writePng(path, w, h, bpp, px) {
  const stride = w * bpp;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  const chunks = [];
  const chunk = (typ, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(typ, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    let crc = 0xffffffff;
    for (const b of crcBuf) { crc ^= b; for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  chunks.push(chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  writeFileSync(path, Buffer.concat(chunks));
}

const [out, ...ins] = process.argv.slice(2);
const imgs = ins.map(readPng);
const bpp = 4;
const H = Math.max(...imgs.map((i) => i.h));
const W = imgs.reduce((s, i) => s + i.w, 0);
const outPx = Buffer.alloc(H * W * bpp, 0);
let xoff = 0;
for (const im of imgs) {
  for (let y = 0; y < im.h; y += 1) {
    for (let x = 0; x < im.w; x += 1) {
      const si = (y * im.w + x) * im.bpp;
      const di = (y * W + xoff + x) * bpp;
      outPx[di] = im.px[si]; outPx[di + 1] = im.px[si + 1]; outPx[di + 2] = im.px[si + 2]; outPx[di + 3] = 255;
    }
  }
  xoff += im.w;
}
writePng(out, W, H, bpp, outPx);
console.log(`→ ${out} (${W}x${H})`);
