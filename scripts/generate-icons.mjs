// Generates the PWA icons without any image library: a hand-rolled PNG encoder
// (zlib from Node itself) drawing a white notepad on the indigo brand color at
// 4x supersampling, then box-downsampling for anti-aliased edges.
//
// Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets", "icons");
mkdirSync(OUT_DIR, { recursive: true });

const INDIGO = [79, 70, 229];   // #4f46e5
const INDIGO_DARK = [67, 56, 202];
const WHITE = [255, 255, 255];
const SS = 4; // supersampling factor

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function roundedRectContains(x, y, x0, y0, w, h, r) {
  if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) return false;
  const cx = x < x0 + r ? x0 + r : x > x0 + w - r ? x0 + w - r : x;
  const cy = y < y0 + r ? y0 + r : y > y0 + h - r ? y0 + h - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function drawIcon(size, { maskable = false } = {}) {
  const big = size * SS;
  // RGBA canvas at supersampled resolution, filled with the brand background.
  const canvas = Buffer.alloc(big * big * 4);
  for (let i = 0; i < big * big; i += 1) {
    const [r, g, b] = i % 7 === 0 ? INDIGO_DARK : INDIGO; // subtle texture, downsampled away
    canvas[i * 4] = r;
    canvas[i * 4 + 1] = g;
    canvas[i * 4 + 2] = b;
    canvas[i * 4 + 3] = 255;
  }

  // Maskable icons must keep key content inside the central 80% safe zone.
  const noteW = (maskable ? 0.46 : 0.56) * big;
  const noteH = noteW * 1.18;
  const noteX = (big - noteW) / 2;
  const noteY = (big - noteH) / 2;
  const radius = noteW * 0.1;

  const paint = (x0, y0, w, h, r, color) => {
    const xMin = Math.max(0, Math.floor(x0));
    const xMax = Math.min(big, Math.ceil(x0 + w));
    const yMin = Math.max(0, Math.floor(y0));
    const yMax = Math.min(big, Math.ceil(y0 + h));
    for (let y = yMin; y < yMax; y += 1) {
      for (let x = xMin; x < xMax; x += 1) {
        if (!roundedRectContains(x, y, x0, y0, w, h, r)) continue;
        const idx = (y * big + x) * 4;
        canvas[idx] = color[0];
        canvas[idx + 1] = color[1];
        canvas[idx + 2] = color[2];
        canvas[idx + 3] = 255;
      }
    }
  };

  paint(noteX, noteY, noteW, noteH, radius, WHITE);

  // Header dot + three text lines, in brand indigo.
  const margin = noteW * 0.16;
  const lineH = noteH * 0.055;
  paint(noteX + margin, noteY + noteH * 0.2, noteW * 0.12, noteH * 0.1, noteH * 0.03, INDIGO);
  for (let i = 0; i < 3; i += 1) {
    const lineW = noteW * (i === 2 ? 0.46 : 0.68);
    paint(noteX + margin, noteY + noteH * (0.4 + i * 0.14), lineW, lineH, lineH / 2, INDIGO);
  }

  // Box downsample SSxSS blocks for anti-aliasing.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const idx = (((y * SS + sy) * big) + (x * SS + sx)) * 4;
          r += canvas[idx]; g += canvas[idx + 1]; b += canvas[idx + 2]; a += canvas[idx + 3];
        }
      }
      const o = (y * size + x) * 4;
      const n = SS * SS;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, out);
}

const targets = [
  { name: "icon-192.png", size: 192, maskable: false },
  { name: "icon-512.png", size: 512, maskable: false },
  { name: "maskable-512.png", size: 512, maskable: true }
];

for (const target of targets) {
  const png = drawIcon(target.size, { maskable: target.maskable });
  writeFileSync(join(OUT_DIR, target.name), png);
  console.log(`wrote assets/icons/${target.name} (${png.length} bytes)`);
}
