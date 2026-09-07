/**
 * vgpu's spectral light mesh, rebuilt on the CPU whenever the lamp or the frame
 * moves.
 *
 * 128 wavelengths x 24 beam slices are traced through the prism's cross-section
 * and written as three contiguous ribbons of quads: the white beam arriving, the
 * spans inside the glass, and the dispersed fan leaving it. Only `position.xy`
 * and one intensity travel to the GPU — the vertex shader recovers every other
 * attribute from the global vertex index, which is why the layout below is fixed
 * and shared with `light-vertex.wgsl`.
 */
import {
  PRISM_BEAM_SLICES,
  PRISM_LIGHT_EXPOSURE,
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_SPECTRAL_SAMPLES,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  clampBeamWidth,
  type PrismTriangle,
  type Vec2,
} from "./constants";
import {
  add2,
  cross2,
  dot2,
  intersectTriangle,
  iorAt,
  normalize2,
  scale2,
  subtract2,
  tracePrismDetailed,
  wavelengthToBeamRgb,
  type TracedPath,
} from "./optics";

/** Entry plus one point per possible internal bounce. */
export const LIGHT_INTERNAL_SEGMENTS = PRISM_MAX_INTERNAL_BOUNCES + 1;
export const LIGHT_VERTEX_FLOATS = 3;
export const LIGHT_VERTEX_STRIDE = LIGHT_VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export interface LightMeshLayout {
  readonly samples: number;
  readonly beamSlices: number;
  readonly whiteQuads: number;
  readonly internalQuads: number;
  readonly whiteVertices: number;
  readonly internalFirstVertex: number;
  readonly internalVertices: number;
  readonly outgoingFirstVertex: number;
  readonly outgoingVertices: number;
  readonly vertexCount: number;
}

export function lightMeshLayout(
  samples: number = PRISM_SPECTRAL_SAMPLES,
  beamSlices: number = PRISM_BEAM_SLICES
): LightMeshLayout {
  const wavelengths = Math.max(2, Math.floor(samples));
  const slices = Math.max(1, Math.floor(beamSlices));
  const internalQuads = wavelengths * slices * LIGHT_INTERNAL_SEGMENTS;
  const whiteVertices = 6 * slices;
  const internalVertices = 6 * internalQuads;
  const outgoingVertices = (wavelengths - 1) * slices * 6;
  return Object.freeze({
    samples: wavelengths,
    beamSlices: slices,
    whiteQuads: slices,
    internalQuads,
    whiteVertices,
    internalFirstVertex: whiteVertices,
    internalVertices,
    outgoingFirstVertex: whiteVertices + internalVertices,
    outgoingVertices,
    vertexCount: whiteVertices + internalVertices + outgoingVertices,
  });
}

export const HIGH_LIGHT_MESH_LAYOUT = lightMeshLayout();

export interface CollimatedLight {
  readonly center: Vec2;
  readonly direction: Vec2;
  readonly beamHalfWidth: number;
}

export interface Dispersion {
  readonly base: number;
  readonly strength: number;
}

export interface LightMeshOptions {
  readonly light: CollimatedLight;
  readonly dispersion: Dispersion;
  readonly edgeFalloff: number;
  readonly wallHalfExtent: Vec2;
  readonly triangle?: PrismTriangle;
  readonly samples?: number;
  readonly beamSlices?: number;
  readonly exposure?: number;
}

/** A point across the beam, at `profile` in [-1, 1]. */
function beamPoint(light: CollimatedLight, profile: number): Vec2 {
  const across: Vec2 = [-light.direction[1], light.direction[0]];
  return add2(light.center, scale2(across, light.beamHalfWidth * Math.min(1, Math.max(-1, profile))));
}

/** Where a ray leaves the wall rectangle, or its own origin if it never does. */
function clipToWall(origin: Vec2, direction: Vec2, halfExtent: Vec2): Vec2 {
  let nearest = Infinity;
  for (let axis = 0; axis < 2; axis++) {
    const slope = direction[axis]!;
    if (Math.abs(slope) < 1e-8) continue;
    for (const bound of [-halfExtent[axis]!, halfExtent[axis]!]) {
      const t = (bound - origin[axis]!) / slope;
      if (t <= 0 || t >= nearest) continue;
      const other = 1 - axis;
      if (Math.abs(origin[other]! + direction[other]! * t) <= halfExtent[other]! + 1e-6) nearest = t;
    }
  }
  return Number.isFinite(nearest) ? add2(origin, scale2(direction, nearest)) : origin;
}

/** Both ends of a ray's span across the wall rectangle, entry clamped to the origin. */
function wallSpan(origin: Vec2, direction: Vec2, halfExtent: Vec2): [Vec2, Vec2] | undefined {
  let enter = -Infinity;
  let leave = Infinity;
  for (let axis = 0; axis < 2; axis++) {
    const slope = direction[axis]!;
    const start = origin[axis]!;
    const bound = halfExtent[axis]!;
    if (Math.abs(slope) < 1e-8) {
      if (Math.abs(start) > bound) return undefined;
      continue;
    }
    const first = (-bound - start) / slope;
    const second = (bound - start) / slope;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
    if (enter > leave) return undefined;
  }
  enter = Math.max(0, enter);
  if (!Number.isFinite(enter) || !Number.isFinite(leave) || leave < enter) return undefined;
  return [add2(origin, scale2(direction, enter)), add2(origin, scale2(direction, leave))];
}

/** Whether a finite-width slice of the beam touches the prism at all. */
function sliceHitsPrism(triangle: PrismTriangle, beam: CollimatedLight): boolean {
  const across: Vec2 = [-beam.direction[1], beam.direction[0]];
  let polygon: Vec2[] = [triangle.a, triangle.b, triangle.c].map((corner) => {
    const offset = subtract2(corner, beam.center);
    return [dot2(offset, beam.direction), dot2(offset, across)];
  });
  const clip = (signedDistance: (point: Vec2) => number) => {
    const input = polygon;
    polygon = [];
    for (let index = 0; index < input.length; index++) {
      const current = input[index]!;
      const next = input[(index + 1) % input.length]!;
      const here = signedDistance(current);
      const there = signedDistance(next);
      const insideHere = here >= 0;
      const insideThere = there >= 0;
      if (insideHere) polygon.push(current);
      if (insideHere === insideThere) continue;
      const t = here / (here - there);
      polygon.push([
        current[0] + (next[0] - current[0]) * t,
        current[1] + (next[1] - current[1]) * t,
      ]);
    }
  };
  clip((point) => point[0]);
  if (polygon.length === 0) return false;
  clip((point) => point[1] + beam.beamHalfWidth);
  if (polygon.length === 0) return false;
  clip((point) => beam.beamHalfWidth - point[1]);
  return polygon.length > 0;
}

const sameTopology = (a: TracedPath, b: TracedPath) =>
  a.edges.length === b.edges.length && a.edges.every((edge, index) => edge === b.edges[index]);

const farPoint = (path: TracedPath): Vec2 => add2(path.origin, scale2(path.direction, 1));

interface Band {
  readonly wavelength: number;
  readonly paths: (TracedPath | undefined)[];
  readonly boundaryPaths: (TracedPath | undefined)[];
}

export interface LightMeshResult {
  readonly vertices: Float32Array;
  readonly vertexCount: number;
}

export function buildLightMesh(
  options: LightMeshOptions,
  target?: Float32Array,
  scratch?: number[]
): LightMeshResult {
  const triangle = options.triangle ?? PRISM_TRIANGLE;
  const samples = Math.max(2, Math.floor(options.samples ?? PRISM_SPECTRAL_SAMPLES));
  const slices = Math.max(1, Math.floor(options.beamSlices ?? PRISM_BEAM_SLICES));
  const exposure = options.exposure ?? PRISM_LIGHT_EXPOSURE;
  const edgeFalloff = Math.max(0, options.edgeFalloff);
  const { light, dispersion, wallHalfExtent } = options;

  const layout = lightMeshLayout(samples, slices);
  const floats = layout.vertexCount * LIGHT_VERTEX_FLOATS;
  if (target && target.length !== floats) {
    throw new RangeError(`Light mesh target has ${target.length} floats; expected ${floats}.`);
  }

  const out = scratch ?? [];
  out.length = 0;
  const pushVertex = (point: Vec2, intensity: number) => {
    out.push(point[0], point[1], intensity);
  };
  /** One quad, wound to match `decodeLightVertex`'s corner table. */
  const pushQuad = (
    lowerNear: Vec2,
    upperNear: Vec2,
    lowerFar: Vec2,
    upperFar: Vec2,
    nearIntensity: number,
    farIntensity: number = nearIntensity
  ) => {
    pushVertex(lowerNear, nearIntensity);
    pushVertex(upperNear, nearIntensity);
    pushVertex(upperFar, farIntensity);
    pushVertex(lowerNear, nearIntensity);
    pushVertex(upperFar, farIntensity);
    pushVertex(lowerFar, farIntensity);
  };
  /** The negative-intensity sentinel the shader reads as "draw nothing". */
  const pushEmptyQuad = () => pushQuad([0, 0], [0, 0], [0, 0], [0, 0], -1);

  const beamWidth = 2 * light.beamHalfWidth;
  const sliceCenters = Array.from({ length: slices }, (_, index) => -1 + (2 * (index + 0.5)) / slices);
  // Lateral weights: a Gaussian by the edge falloff, tapered so the outermost
  // slices reach zero rather than ending on a step.
  const rawWeights = sliceCenters.map((center) => {
    const taper = Math.min(1, Math.max(0, (Math.abs(center) - 0.55) / 0.45));
    return Math.exp(-edgeFalloff * center * center) * (1 - taper * taper * (3 - 2 * taper));
  });
  const weightSum = rawWeights.reduce((sum, value) => sum + value, 0) || 1;
  const weights = rawWeights.map((value) => value / weightSum);

  const boundaries = Array.from({ length: slices + 1 }, (_, index) => -1 + (2 * index) / slices);
  const boundaryGeometry = boundaries.map((profile) => {
    const origin = beamPoint(light, profile);
    const hit = intersectTriangle(triangle, origin, light.direction, 1e-4);
    const entry =
      hit && dot2(light.direction, hit.normal) < 0
        ? add2(origin, scale2(light.direction, hit.t))
        : undefined;
    return { profile, origin, entry, wall: wallSpan(origin, light.direction, wallHalfExtent) };
  });

  // --- the white beam arriving, one quad per slice ---
  const backwards: Vec2 = [-light.direction[0], -light.direction[1]];
  for (let slice = 0; slice < slices; slice++) {
    const lower = boundaryGeometry[slice]!;
    const upper = boundaryGeometry[slice + 1]!;
    if (lower.entry && upper.entry) {
      pushQuad(
        clipToWall(lower.entry, backwards, wallHalfExtent),
        clipToWall(upper.entry, backwards, wallHalfExtent),
        lower.entry,
        upper.entry,
        0,
        6
      );
      continue;
    }
    // A slice that misses the glass entirely runs the full width of the wall.
    const middle = (lower.profile + upper.profile) * 0.5;
    const clipped = sliceHitsPrism(triangle, {
      center: beamPoint(light, middle),
      direction: light.direction,
      beamHalfWidth: light.beamHalfWidth * (upper.profile - lower.profile) * 0.5,
    });
    if (!clipped && lower.wall && upper.wall) {
      pushQuad(lower.wall[0], upper.wall[0], lower.wall[1], upper.wall[1], 6);
    } else {
      pushEmptyQuad();
    }
  }

  // --- one traced band per wavelength ---
  const bands: (Band | undefined)[] = [];
  const traceAt = (wavelength: number, profile: number) =>
    tracePrismDetailed(
      triangle,
      beamPoint(light, profile),
      light.direction,
      iorAt(wavelength, dispersion.base, dispersion.strength)
    );
  for (let index = 0; index < samples; index++) {
    const wavelength =
      PRISM_WAVELENGTHS.min +
      (PRISM_WAVELENGTHS.max - PRISM_WAVELENGTHS.min) * (index / (samples - 1));
    const paths = sliceCenters.map((profile) => traceAt(wavelength, profile));
    const boundaryPaths = boundaries.map((profile) => traceAt(wavelength, profile));
    if (paths.every((path) => !path) && boundaryPaths.every((path) => !path)) {
      bands.push(undefined);
      continue;
    }
    bands.push({ wavelength, paths, boundaryPaths });
  }

  /**
   * Radiance of one band's slice, from how far its outgoing ray has spread
   * against its neighbours: a fan that opens wide is dimmer per unit width.
   */
  const intensityFor = (index: number, slice: number): number => {
    const path = bands[index]?.paths[slice];
    if (!path) return 0;
    let low = index - 1;
    while (low >= 0 && !bands[low]?.paths[slice]) low--;
    let high = index + 1;
    while (high < bands.length && !bands[high]?.paths[slice]) high++;
    if (low < 0) low = index;
    if (high >= bands.length) high = index;
    if (low === high) return 0;
    const lower = bands[low]!.paths[slice]!;
    const upper = bands[high]!.paths[slice]!;
    if (!sameTopology(lower, upper)) return 0;
    const mean = normalize2(add2(lower.direction, upper.direction));
    const spread = Math.abs(cross2(subtract2(farPoint(upper), farPoint(lower)), mean));
    const span = (high - low) / (bands.length - 1);
    return (
      (exposure * beamWidth * weights[slice]! * path.transmission) /
      Math.max(spread / span, 1e-4)
    );
  };
  const intensities = bands.map((band, index) =>
    sliceCenters.map((_, slice) => (band ? intensityFor(index, slice) : 0))
  );

  // The whole spectrum recombines to white; normalise so it peaks where the
  // incoming beam does rather than blowing out where the fan is densest.
  const summed = bands.reduce<[number, number, number]>(
    (total, band) => {
      if (!band) return total;
      const rgb = wavelengthToBeamRgb(band.wavelength);
      return [total[0] + rgb[0], total[1] + rgb[1], total[2] + rgb[2]];
    },
    [0, 0, 0]
  );
  const internalScale = 6 / Math.max(summed[0], summed[1], summed[2], 1);

  // --- the spans inside the glass ---
  for (const band of bands) {
    if (!band) {
      for (let quad = 0; quad < slices * LIGHT_INTERNAL_SEGMENTS; quad++) pushEmptyQuad();
      continue;
    }
    for (let slice = 0; slice < slices; slice++) {
      const lower = band.boundaryPaths[slice];
      const upper = band.boundaryPaths[slice + 1];
      const valid = !!(lower && upper && sameTopology(lower, upper));
      const intensity = valid
        ? internalScale * (lower!.entryTransmission + upper!.entryTransmission) * 0.5
        : 0;
      for (let segment = 0; segment < LIGHT_INTERNAL_SEGMENTS; segment++) {
        const lowerStart = lower?.points[segment];
        const lowerEnd = lower?.points[segment + 1];
        const upperStart = upper?.points[segment];
        const upperEnd = upper?.points[segment + 1];
        if (valid && lowerStart && lowerEnd && upperStart && upperEnd) {
          pushQuad(lowerStart, upperStart, lowerEnd, upperEnd, intensity);
        } else {
          pushEmptyQuad();
        }
      }
    }
  }

  // --- the dispersed fan leaving the glass ---
  for (let index = 0; index < samples - 1; index++) {
    const near = bands[index];
    const far = bands[index + 1];
    for (let slice = 0; slice < slices; slice++) {
      const lower = near?.paths[slice];
      const upper = far?.paths[slice];
      if (!lower || !upper || !sameTopology(lower, upper)) {
        pushEmptyQuad();
        continue;
      }
      const nearIntensity = intensities[index]![slice]!;
      const farIntensity = intensities[index + 1]![slice]!;
      const lowerWall = clipToWall(lower.origin, lower.direction, wallHalfExtent);
      const upperWall = clipToWall(upper.origin, upper.direction, wallHalfExtent);
      pushVertex(lower.origin, nearIntensity);
      pushVertex(upper.origin, farIntensity);
      pushVertex(upperWall, farIntensity);
      pushVertex(lower.origin, nearIntensity);
      pushVertex(upperWall, farIntensity);
      pushVertex(lowerWall, nearIntensity);
    }
  }

  const written = out.length / LIGHT_VERTEX_FLOATS;
  if (out.length !== floats || written !== layout.vertexCount) {
    throw new Error(`Light mesh wrote ${written} vertices; expected ${layout.vertexCount}.`);
  }
  const vertices = target ?? new Float32Array(floats);
  vertices.set(out);
  return { vertices, vertexCount: written };
}

/**
 * Where the lamp sits for an angle of incidence on the prism's right face, and
 * which way it points. The beam always lands on the same face; the pointer only
 * swings how steeply it arrives.
 */
export function lampForIncidence(
  incidenceDegrees: number,
  beamWidth: number,
  target: number,
  triangle: PrismTriangle = PRISM_TRIANGLE
): CollimatedLight {
  const edge = subtract2(triangle.a, triangle.c);
  const length = Math.hypot(edge[0], edge[1]);
  const radians = (incidenceDegrees * Math.PI) / 180;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  const facing: Vec2 = [-edge[1] / length, edge[0] / length];
  const heading: Vec2 = [facing[0] * cos - facing[1] * sin, facing[0] * sin + facing[1] * cos];

  const width = clampBeamWidth(beamWidth);
  // Keep the whole beam on the face: at a shallow angle it covers more of it, so
  // the aim point is pulled further from both corners.
  const margin = Math.min(
    0.45,
    width / (2 * length * Math.max(0.05, Math.abs(Math.cos(radians)))) + 1e-4
  );
  const t = Math.min(1, Math.max(0, Math.min(1 - margin, Math.max(margin, target))));
  const aim: Vec2 = [
    triangle.a[0] + (triangle.c[0] - triangle.a[0]) * t,
    triangle.a[1] + (triangle.c[1] - triangle.a[1]) * t,
  ];
  const center: Vec2 = [aim[0] - 6.5 * heading[0], aim[1] - 6.5 * heading[1]];
  const toAim = subtract2(aim, center);
  const distance = Math.hypot(toAim[0], toAim[1]);
  if (!Number.isFinite(distance) || distance <= 1e-8) {
    throw new Error("A collimated light needs distinct finite center and target points.");
  }
  return {
    center,
    direction: [toAim[0] / distance, toAim[1] / distance],
    beamHalfWidth: 0.5 * width,
  };
}
