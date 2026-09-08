/**
 * Rasterises the monogram into the app icons.
 *
 * The SVG favicon is enough for a browser tab, but not for a home screen: iOS
 * ignores `rel="icon"` entirely, and with no `apple-touch-icon` to fall back on
 * it draws its own tile — a grey square with the first letter of the title in
 * it, which is what was appearing when the site was added to a phone. Android's
 * installer wants PNGs in a manifest for the same reason.
 *
 * The mark is the one `src/components/Logo.astro` and `public/favicon.svg`
 * draw, in the same coordinates: a ring with a straight stem a third of the way
 * across it, the ring's own right side serving as the D's bowl. It is drawn
 * analytically rather than by rasterising the SVG, so this needs no toolchain
 * beyond node — the two strokes are a circle and a segment, and the distance to
 * each is exact.
 *
 * The home-screen tiles are opaque. A transparent icon is composited on black by
 * iOS, which would put a black mark on a black ground.
 *
 * The tab icon is the exception: it is the mark in white on a transparent
 * ground, so that it sits on the browser's own chrome the way `favicon.svg`
 * does rather than punching a plaster-coloured tile into it. White because
 * a PNG cannot follow the chrome from light to dark the way the SVG's
 * `currentColor` does, and the SVG is what a browser reaches for first — this
 * is the fallback, and it is the dark chrome it has to fall back onto.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/** The mark, in the 100x100 box every copy of it is drawn in. */
const RADIUS = 45;
const STEM_X = 28.4;
const STEM_HALF = Math.sqrt(RADIUS ** 2 - (50 - STEM_X) ** 2);
const STROKE = 9.5;

/** The lit plaster the site is on, and the ink the mark is drawn in. */
const GROUND = [0xd2, 0xcc, 0xc2];
const INK = [0x0d, 0x0d, 0x0f];
/** The tab icon's ink, matching the white `favicon.svg` takes on dark chrome. */
const CHROME_INK = [0xf4, 0xf4, 0xf6];
/** How much of the tile the mark takes, leaving iOS its rounding margin. */
const COVERAGE = 0.62;
/** Samples per axis. The mark is two thin strokes; edges have to be clean. */
const SUPERSAMPLE = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const ICONS = [
  { file: "apple-touch-icon.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "favicon-96.png", size: 96, ink: CHROME_INK, transparent: true },
];

for (const icon of ICONS) {
  const { size, ink = INK, transparent = false } = icon;
  writeFileSync(`public/${icon.file}`, png(render(size, ink, transparent), size, transparent));
  console.log(
    `public/${icon.file}  ${size}x${size}  ${transparent ? "transparent" : "on plaster"}`
  );
}

/** Distance from a point to the mark, in the 100x100 box, negative inside. */
function markDistance(x, y) {
  const ring = Math.abs(Math.hypot(x - 50, y - 50) - RADIUS);
  const stemY = Math.min(Math.max(y, 50 - STEM_HALF), 50 + STEM_HALF);
  const stem = Math.hypot(x - STEM_X, y - stemY);
  return Math.min(ring, stem) - STROKE / 2;
}

/**
 * A tile with the mark centred on it, in `ink`.
 *
 * Opaque, the mark is composited onto the plaster. Transparent, the ground is
 * left empty and the coverage becomes the alpha instead — the ink is written
 * flat across the whole tile so that the antialiased edge fades out in alpha
 * rather than towards a background colour, which is what would otherwise leave
 * a plaster-coloured fringe once the browser drew it on its own dark chrome.
 */
function render(size, ink = INK, transparent = false) {
  const channels = transparent ? 4 : 3;
  const pixels = new Uint8Array(size * size * channels);
  const scale = 100 / (size * COVERAGE);
  const origin = 50 - (size / 2) * scale;
  const step = scale / SUPERSAMPLE;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let inside = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++)
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = origin + px * scale + (sx + 0.5) * step;
          const y = origin + py * scale + (sy + 0.5) * step;
          if (markDistance(x, y) <= 0) inside++;
        }
      const coverage = inside / (SUPERSAMPLE * SUPERSAMPLE);
      const offset = (py * size + px) * channels;
      if (transparent) {
        for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = ink[channel];
        pixels[offset + 3] = Math.round(255 * coverage);
      } else {
        for (let channel = 0; channel < 3; channel++)
          pixels[offset + channel] = Math.round(
            GROUND[channel] * (1 - coverage) + ink[channel] * coverage
          );
      }
    }
  return pixels;
}

/** A minimal 8-bit truecolour PNG, with an alpha channel when asked for one. */
function png(pixels, size, alpha = false) {
  const stride = size * (alpha ? 4 : 3);
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // colour type: truecolour, with or without alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
