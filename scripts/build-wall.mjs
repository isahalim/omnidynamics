/**
 * Bakes the plaster wall material sampled by hero-fractal-background-draw.wgsl.
 *
 * Channel layout matches vgpu's own wall pass:
 *   r = albedo variation, g/b = tangent-space normal XY, a = roughness
 *
 * The height field is vgpu's two-octave plaster (generate-wall.ts) made
 * tileable, plus a layer of fine directional scratches.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 512;
// vgpu's plaster frequencies. Integer so the lattice wraps without a seam.
const COARSE = 34;
const FINE = 117;
const SCRATCH_COUNT = 220;

const fract = (v) => v - Math.floor(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (t) => t * t * (3 - 2 * t);

/** vgpu's value hash, with the lattice wrapped so the tile repeats seamlessly. */
function hash(x, y, period) {
  const wx = ((x % period) + period) % period;
  const wy = ((y % period) + period) % period;
  return fract(Math.sin(wx * 127.1 + wy * 311.7) * 43758.5453123);
}

function noise(x, y, period) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(fract(x)), fy = smooth(fract(y));
  const top = hash(ix, iy, period) * (1 - fx) + hash(ix + 1, iy, period) * fx;
  const bot = hash(ix, iy + 1, period) * (1 - fx) + hash(ix + 1, iy + 1, period) * fx;
  return top * (1 - fy) + bot * fy;
}

/** Octaves double exactly (vgpu uses 2.07) so every octave stays on-lattice. */
function fbm(x, y, octaves, period) {
  let value = 0, amplitude = 0.5, frequency = 1, weight = 0;
  for (let o = 0; o < octaves; o++) {
    value += noise(x * frequency, y * frequency, period * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / weight;
}

// Scratches: thin, mostly-parallel gouges with varied length and depth.
const scratches = [];
{
  let seed = 20260907;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < SCRATCH_COUNT; i++) {
    const angle = (-24 + (rand() - 0.5) * 46) * (Math.PI / 180);
    const length = 0.02 + rand() ** 2.2 * 0.20;
    scratches.push({
      x: rand(), y: rand(),
      dx: Math.cos(angle) * length, dy: Math.sin(angle) * length,
      width: 0.00035 + rand() * 0.0011,
      depth: (0.25 + rand() * 0.75) * (rand() < 0.22 ? -1 : 1),
    });
  }
}

/** Shortest distance to a scratch segment, measured on the wrapped tile. */
function scratchField(u, v) {
  let total = 0;
  for (const s of scratches) {
    // Wrap the sample into the segment's neighbourhood so scratches cross the seam.
    let px = u - s.x, py = v - s.y;
    px -= Math.round(px); py -= Math.round(py);
    const lenSq = s.dx * s.dx + s.dy * s.dy || 1;
    const t = clamp01((px * s.dx + py * s.dy) / lenSq);
    const dx = px - s.dx * t, dy = py - s.dy * t;
    const dist = Math.hypot(dx, dy);
    if (dist > s.width * 4) continue;
    // Taper the ends so a scratch fades in rather than stopping flat.
    const taper = Math.sin(Math.PI * t) ** 0.6;
    total += Math.exp(-(dist * dist) / (s.width * s.width)) * s.depth * taper;
  }
  return total;
}

function plasterHeight(u, v) {
  return (
    fbm(u * COARSE, v * COARSE, 5, COARSE) * 0.65 +
    fbm(u * FINE, v * FINE, 2, FINE) * 0.35 +
    scratchField(u, v) * 0.055
  );
}

const pixels = new Uint8Array(SIZE * SIZE * 4);
const epsilon = 1 / SIZE;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const u = (x + 0.5) / SIZE, v = (y + 0.5) / SIZE;
    const hx = plasterHeight(u + epsilon, v) - plasterHeight(u - epsilon, v);
    const hy = plasterHeight(u, v + epsilon) - plasterHeight(u, v - epsilon);
    const variation = plasterHeight(u, v) - 0.5;
    const o = (y * SIZE + x) * 4;
    const rgba = [
      0.8 + variation * 0.06,
      0.5 - hx * 1.8,
      0.5 - hy * 1.8,
      0.86 + variation * 0.12,
    ];
    for (let c = 0; c < 4; c++) pixels[o + c] = Math.round(clamp01(rgba[c]) * 255);
  }
}

mkdirSync("public/glass", { recursive: true });
writeFileSync("public/glass/wall-material.png", encodePng(pixels, SIZE, SIZE));
console.log(`wall-material.png  ${SIZE}x${SIZE}  ${SCRATCH_COUNT} scratches`);

/** Minimal RGBA8 PNG encoder — avoids pulling an image dependency for one file. */
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw, y * (width * 4 + 1) + 1
    );
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
