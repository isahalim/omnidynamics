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
 * Every tile is the mark in the site's own ink on the site's own plaster,
 * opaquely, the way `favicon.svg` draws it. The white-on-nothing copy these
 * used to be was drawn for dark chrome and had no say in what it landed on:
 * Google composites a result row's icon onto a white disc, where a white mark
 * is a white disc, and that is what the search result was showing. A tile that
 * carries its own ground reads the same in every one of these places, and reads
 * as this site — the plaster is the wall the landing page is lit on.
 *
 * That makes the maskable tile the same drawing as the rest, at a smaller
 * coverage: Android cuts the corners to whatever shape the device likes, so the
 * mark is kept well inside the launcher's safe zone while the plaster bleeds
 * out to the edge behind it.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/** The mark, in the 100x100 box every copy of it is drawn in. */
const RADIUS = 45;
const STEM_X = 28.4;
const STEM_HALF = Math.sqrt(RADIUS ** 2 - (50 - STEM_X) ** 2);
const STROKE = 9.5;

/** The ink the mark is drawn in, and the plaster it is drawn on: `--ink` and
 * `--wall` from `src/layouts/Base.astro`, so the tile is a chip of the page. */
const INK = [0x16, 0x13, 0x0f];
const GROUND = [0xd2, 0xcc, 0xc2];
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
  { file: "icon-maskable-512.png", size: 512, coverage: MASKABLE_COVERAGE },
];

for (const icon of ICONS) {
  const { size, coverage = COVERAGE } = icon;
  writeFileSync(`public/${icon.file}`, png(render(size, GROUND, coverage), size));
  console.log(`public/${icon.file}  ${size}x${size}  on plaster`);
}

/** Distance from a point to the mark, in the 100x100 box, negative inside. */
function markDistance(x, y) {
  const ring = Math.abs(Math.hypot(x - 50, y - 50) - RADIUS);
  const stemY = Math.min(Math.max(y, 50 - STEM_HALF), 50 + STEM_HALF);
  const stem = Math.hypot(x - STEM_X, y - stemY);
  return Math.min(ring, stem) - STROKE / 2;
}

/**
 * A tile with the mark centred on it, composited onto `ground`.
 *
 * Every tile carries its ground, so the antialiased edge always has a known
 * colour to fade towards. A transparent tile would leave that edge to whatever
 * the browser drew behind it, and — more to the point — would let each place
 * the tile lands choose its own ground, which is how the same drawing came out
 * as a pale disc in a dark search result and a dark mark on a light one.
 */
function render(size, ground = GROUND, tileCoverage = COVERAGE) {
  const pixels = new Uint8Array(size * size * 3);
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
      const offset = (py * size + px) * 3;
      for (let channel = 0; channel < 3; channel++)
        pixels[offset + channel] = Math.round(
          ground[channel] * (1 - coverage) + INK[channel] * coverage
        );
    }
  return pixels;
}

/** A minimal 8-bit truecolour PNG. Every tile is opaque, so there is no alpha
 * channel to write. */
function png(pixels, size) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
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
