/**
 * The 2D ray tracer vgpu runs on the CPU to build its spectral light mesh.
 *
 * Everything works in the prism's cross-section: the triangle is convex, so a
 * ray entering one edge either leaves through another or is totally internally
 * reflected, and three bounces are enough to resolve every path this shot
 * produces.
 */
import {
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_WAVELENGTHS,
  type PrismTriangle,
  type Vec2,
} from "./constants";

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const subtract2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const normalize2 = (a: Vec2): Vec2 => scale2(a, 1 / (Math.hypot(a[0], a[1]) || 1));

export interface EdgeHit {
  readonly t: number;
  readonly normal: Vec2;
  /** 0 = AB, 1 = BC, 2 = CA. */
  readonly edge: number;
}

/** Nearest edge of the triangle a ray from `origin` reaches beyond `minimum`. */
export function intersectTriangle(
  triangle: PrismTriangle,
  origin: Vec2,
  direction: Vec2,
  minimum: number
): EdgeHit | undefined {
  const corners = [triangle.a, triangle.b, triangle.c];
  let nearest: EdgeHit | undefined;
  for (let index = 0; index < 3; index++) {
    const start = corners[index]!;
    const edge = subtract2(corners[(index + 1) % 3]!, start);
    const denominator = cross2(direction, edge);
    if (denominator === 0) continue;
    const delta = subtract2(start, origin);
    const t = cross2(delta, edge) / denominator;
    const u = cross2(delta, direction) / denominator;
    if (t <= minimum || u < 0 || u > 1) continue;
    if (nearest && nearest.t <= t) continue;
    nearest = { t, normal: normalize2([edge[1], -edge[0]]), edge: index };
  }
  return nearest;
}

/** Snell's law in the plane; undefined on total internal reflection. */
export function refract2(
  incident: Vec2,
  normal: Vec2,
  eta: number
): Vec2 | undefined {
  const cosine = -dot2(incident, normal);
  const k = eta * eta * (1 - cosine * cosine);
  if (k > 1) return undefined;
  const scaled = Math.sqrt(1 - k);
  return add2(scale2(incident, eta), scale2(normal, eta * cosine - scaled));
}

/** Unpolarised Fresnel transmittance across an n1 -> n2 interface. */
export function transmittance(
  incident: Vec2,
  normal: Vec2,
  n1: number,
  n2: number
): number {
  const cosI = Math.min(1, Math.max(0, -dot2(incident, normal)));
  const ratio = n1 / n2;
  const sinT2 = ratio * ratio * (1 - cosI * cosI);
  if (sinT2 >= 1) return 0;
  const cosT = Math.sqrt(1 - sinT2);
  return (
    1 -
    0.5 *
      (((n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT)) ** 2 +
        ((n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI)) ** 2)
  );
}

/** Cauchy dispersion: n = base + strength / lambda^2, lambda in micrometres. */
export function iorAt(nanometres: number, base: number, strength: number): number {
  const micrometres = nanometres * 0.001;
  return base + strength / (micrometres * micrometres);
}

export interface TracedPath {
  readonly origin: Vec2;
  readonly direction: Vec2;
  readonly bounces: number;
  /** Entry point, then every subsequent interface, ending at the exit. */
  readonly points: Vec2[];
  readonly edges: number[];
  /** Product of the Fresnel transmittances along the path. */
  readonly transmission: number;
  /** The entry interface's transmittance alone, used by the internal span. */
  readonly entryTransmission: number;
}

/**
 * Follows one ray in through the triangle and out the far side, reflecting on
 * total internal reflection until it escapes or runs out of bounces.
 */
export function tracePrismDetailed(
  triangle: PrismTriangle,
  origin: Vec2,
  direction: Vec2,
  ior: number,
  maxBounces: number = PRISM_MAX_INTERNAL_BOUNCES
): TracedPath | undefined {
  const entry = intersectTriangle(triangle, origin, direction, 1e-4);
  if (!entry || dot2(direction, entry.normal) >= 0) return undefined;
  let position = add2(origin, scale2(direction, entry.t));
  let inside = refract2(direction, entry.normal, 1 / ior);
  if (!inside) return undefined;

  const points: Vec2[] = [position];
  const edges: number[] = [entry.edge];
  const entryTransmission = transmittance(direction, entry.normal, 1, ior);
  let carried = entryTransmission;

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const hit = intersectTriangle(triangle, position, inside, 1e-4);
    if (!hit) break;
    position = add2(position, scale2(inside, hit.t));
    points.push(position);
    edges.push(hit.edge);
    const inwardNormal = scale2(hit.normal, -1);
    const outgoing = refract2(inside, inwardNormal, ior);
    if (outgoing) {
      carried *= transmittance(inside, inwardNormal, ior, 1);
      return {
        origin: position,
        direction: normalize2(outgoing),
        bounces: bounce,
        points,
        edges,
        transmission: carried,
        entryTransmission,
      };
    }
    inside = subtract2(inside, scale2(hit.normal, 2 * dot2(inside, hit.normal)));
  }
  return undefined;
}

/** CIE D65 relative spectral power, in 10 nm steps from 400 nm. */
const D65 = [
  82.7549, 91.486, 93.4318, 86.6823, 104.865, 117.008, 117.812, 114.861, 115.923,
  108.811, 109.354, 107.802, 104.79, 107.689, 104.405, 104.046, 100, 96.3342,
  95.788, 88.6856, 90.0062, 89.5991, 87.6987, 83.2886, 83.6992, 80.0268, 80.2146,
  82.2778, 78.2842, 69.7213, 71.6091,
];

/** Wyman's multi-lobe Gaussian CIE fit, through sRGB primaries. */
export function wavelengthToBeamRgb(nanometres: number): [number, number, number] {
  const w = Math.min(PRISM_WAVELENGTHS.max, Math.max(PRISM_WAVELENGTHS.min, nanometres));
  const lobe = (value: number, peak: number, lower: number, upper: number) => {
    const t = (value - peak) * (value < peak ? lower : upper);
    return Math.exp(-0.5 * t * t);
  };
  const x =
    0.362 * lobe(w, 442, 0.0624, 0.0374) +
    1.056 * lobe(w, 599.8, 0.0264, 0.0323) -
    0.065 * lobe(w, 501.1, 0.049, 0.0382);
  const y = 0.821 * lobe(w, 568.8, 0.0213, 0.0247) + 0.286 * lobe(w, 530.9, 0.0613, 0.0322);
  const z = 1.217 * lobe(w, 437, 0.0845, 0.0278) + 0.681 * lobe(w, 459, 0.0385, 0.0725);

  const linear = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
  const lowest = Math.min(0, ...linear);
  const lifted = linear.map((value) => value - lowest);
  const peak = Math.max(...lifted, Number.EPSILON);

  const index = Math.min(D65.length - 1, Math.max(0, (w - PRISM_WAVELENGTHS.min) / 10));
  const lower = Math.min(D65.length - 2, Math.floor(index));
  const fraction = index - lower;
  const power = ((D65[lower]! * (1 - fraction) + D65[lower + 1]! * fraction) / 100) * y / 1.0347;
  const exposure = (1 - Math.exp(-4.5 * power)) / (1 - Math.exp(-4.5));

  return [
    (lifted[0]! / peak) * exposure * 1.1868,
    (lifted[1]! / peak) * exposure * 1,
    (lifted[2]! / peak) * exposure * 2.2495,
  ];
}
