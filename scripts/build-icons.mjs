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
 * Every tile is the mark in white on nothing, the way `favicon.svg` draws it on
 * dark chrome. A PNG cannot follow the chrome from light to dark the way the
 * SVG's `currentColor` does, and white on transparent is what each of the
 * places these land is dark enough to want: the tab strip, and iOS, which
 * composites a transparent home-screen icon onto black.
 *
 * Android is the exception, and the reason for the maskable tile. It sets a
 * non-maskable icon on a light plate of its own, where a white mark would
 * vanish, so the maskable copy carries its own ink ground — full bleed, with
 * the mark kept well inside the launcher's safe zone since the corners are cut
 * to whatever shape the device likes.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/** The mark, in the 100x100 box every copy of it is drawn in. */
const RADIUS = 45;
const STEM_X = 28.4;
const STEM_HALF = Math.sqrt(RADIUS ** 2 - (50 - STEM_X) ** 2);
const STROKE = 9.5;

/** The ink the mark is drawn in, matching the white `favicon.svg` takes on dark
 * chrome, and the ground the one opaque tile is drawn on. */
const INK = [0xf4, 0xf4, 0xf6];
const GROUND = [0x0d, 0x0d, 0x0f];
/** How much of the tile the mark takes, leaving iOS its rounding margin, and
 * how much of the maskable one, leaving the launcher its safe zone. */
const COVERAGE = 0.62;
const MASKABLE_COVERAGE = 0.44;
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
  { file: "favicon-96.png", size: 96 },
  { file: "icon-maskable-512.png", size: 512, ground: GROUND, coverage: MASKABLE_COVERAGE },
];

for (const icon of ICONS) {
  const { size, ground = null, coverage = COVERAGE } = icon;
  writeFileSync(`public/${icon.file}`, png(render(size, ground, coverage), size, !ground));
  console.log(`public/${icon.file}  ${size}x${size}  ${ground ? "on ink" : "transparent"}`);
}

/** Distance from a point to the mark, in the 100x100 box, negative inside. */
function markDistance(x, y) {
  const ring = Math.abs(Math.hypot(x - 50, y - 50) - RADIUS);
  const stemY = Math.min(Math.max(y, 50 - STEM_HALF), 50 + STEM_HALF);
  const stem = Math.hypot(x - STEM_X, y - stemY);
  return Math.min(ring, stem) - STROKE / 2;
}

/**
 * A tile with the mark centred on it.
 *
 * Given a `ground` the mark is composited onto it. Without one the ground is
 * left empty and the coverage becomes the alpha instead — the ink is written
 * flat across the whole tile so that the antialiased edge fades out in alpha
 * rather than towards a background colour, which is what would otherwise leave
 * a fringe once the browser drew it on its own chrome.
 */
function render(size, ground = null, tileCoverage = COVERAGE) {
  const channels = ground ? 3 : 4;
  const pixels = new Uint8Array(size * size * channels);
  const scale = 100 / (size * tileCoverage);
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
      if (ground) {
        for (let channel = 0; channel < 3; channel++)
          pixels[offset + channel] = Math.round(
            ground[channel] * (1 - coverage) + INK[channel] * coverage
          );
      } else {
        for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = INK[channel];
        pixels[offset + 3] = Math.round(255 * coverage);
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
