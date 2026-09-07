/**
 * Derives the linear wall tint in hero-fractal-background-draw.wgsl.
 *
 * vgpu's light pipeline paints its wall #d2ccc2 with a normal strength of 0.6
 * (both read off the wall nodes on vgpu.sh/?debug). Our wall reaches the screen
 * through the same chain vgpu's does — albedo * diffuse + specular, then
 * `presentCeramic`'s ACES curve and 2.2 gamma — so the constant in the shader
 * is not the target colour itself but the linear albedo that lands on it.
 *
 * This replicates that chain over the baked plaster in public/glass and inverts
 * it, so re-baking the material or changing the shading constants can be
 * followed by re-reading the tint rather than guessing at it.
 *
 *     node scripts/check-wall-color.mjs [normalStrength]
 */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const TARGET_HEX = "d2ccc2";
const MATERIAL = "public/glass/wall-material.png";

// Must track hero-wall.wgsl.
const NORMAL_STRENGTH = Number(process.argv[2] ?? 0.6);
const MICRO_STRENGTH = 1.05;
const MICRO_FREQUENCY = 7;
const AMBIENT = 0.5;
const LIGHT_DIRECTION = normalize([-0.48, 0.56, 0.68]);

function normalize(v) {
  const length = Math.hypot(...v);
  return v.map((x) => x / length);
}

/** Minimal RGBA8 PNG decoder — the encoder in build-wall.mjs has no reader. */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === "IDAT") parts.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = value & 255;
    }
  }
  return { width, height, data: out };
}

const { width, height, data } = decodePng(readFileSync(MATERIAL));
const texel = (x, y) => {
  const o = ((((y % height) + height) % height) * width +
    (((x % width) + width) % width)) * 4;
  return [data[o] / 255, data[o + 1] / 255, data[o + 2] / 255, data[o + 3] / 255];
};

// Mean shading response of the plaster, the same way shadeWall computes it.
let shadeSum = 0;
let specularSum = 0;
let samples = 0;
for (let y = 0; y < height; y += 3) {
  for (let x = 0; x < width; x += 3) {
    const material = texel(x, y);
    const micro = texel(
      Math.round(x * MICRO_FREQUENCY + 0.371 * width),
      Math.round(y * MICRO_FREQUENCY + 0.613 * height)
    );
    const xy = [
      (material[1] * 2 - 1) * NORMAL_STRENGTH + (micro[1] * 2 - 1) * MICRO_STRENGTH,
      (material[2] * 2 - 1) * NORMAL_STRENGTH + (micro[2] * 2 - 1) * MICRO_STRENGTH,
    ];
    const limit = Math.max(Math.hypot(...xy), 1);
    const nx = xy[0] / limit;
    const ny = xy[1] / limit;
    const normal = normalize([nx, ny, Math.sqrt(Math.max(1 - nx * nx - ny * ny, 0.0001))]);
    const facing = Math.max(dot(normal, LIGHT_DIRECTION), 0);
    const halfway = normalize([
      LIGHT_DIRECTION[0],
      LIGHT_DIRECTION[1],
      LIGHT_DIRECTION[2] + 1,
    ]);
    shadeSum += material[0] * (AMBIENT + (1 - AMBIENT) * facing);
    specularSum +=
      Math.pow(Math.max(dot(normal, halfway), 0), 48 + (4 - 48) * material[3]) *
      (0.12 + (0.025 - 0.12) * material[3]);
    samples++;
  }
}
const meanShade = shadeSum / samples;
const meanSpecular = specularSum / samples;

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

const aces = (c) => {
  const value = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return Math.min(1, Math.max(0, value));
};

/** ACES is monotonic over the range we use, so a bisection inverts it. */
const acesInverse = (target) => {
  let low = 0;
  let high = 64;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (aces(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

const target = [0, 2, 4].map((i) => parseInt(TARGET_HEX.slice(i, i + 2), 16) / 255);
const tint = target.map(
  (channel) => (acesInverse(channel ** 2.2) / 1.08 - meanSpecular) / meanShade
);

const forward = (multiplier) =>
  "#" +
  tint
    .map((t) =>
      Math.round(aces((t * multiplier * meanShade + meanSpecular) * 1.08) ** (1 / 2.2) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("");

console.log(`wall material   ${width}x${height}  normal strength ${NORMAL_STRENGTH}`);
console.log(`mean shade      ${meanShade.toFixed(4)}`);
console.log(`mean specular   ${meanSpecular.toFixed(5)}`);
console.log(`\nWALL_COLOR      vec3f(${tint.map((v) => v.toFixed(3)).join(", ")})   -> #${TARGET_HEX}`);
console.log("\nlight pool falloff");
for (const multiplier of [1.08, 1.0, 0.92, 0.82])
  console.log(`  ${multiplier.toFixed(2)}x  ${forward(multiplier)}`);
