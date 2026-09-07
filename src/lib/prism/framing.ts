/**
 * Places the prism inside a rectangle of the canvas rather than at its centre.
 *
 * The camera always looks at the origin, so a page that wants the prism beside
 * its copy dollies back until the shape fits the rectangle, then shifts the
 * projection so it lands in it. That keeps the wall a single full-bleed plane —
 * the copy sits on the same lit plaster the glass stands on.
 */
import { cameraView, wallExtent } from "./camera";
import { CAMERA_FOV_DEGREES, PRISM_FRONT_Z, type Vec2 } from "./constants";
import { prismMeshPositions } from "./geometry";

export interface ProjectionFraming {
  readonly scale: number;
  readonly offset: Vec2;
}

export const IDENTITY_FRAMING: ProjectionFraming = { scale: 1, offset: [0, 0] };

/** A rectangle of the canvas, as fractions from its top-left corner. */
export interface FramingViewport {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Bounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const MIN_DISTANCE = PRISM_FRONT_Z + 0.1;
const MAX_DISTANCE = 32;
const MESH_POSITIONS = prismMeshPositions();

export function applyProjectionFraming(
  matrix: Float32Array,
  framing: ProjectionFraming
): Float32Array {
  if (framing.scale === 1 && framing.offset[0] === 0 && framing.offset[1] === 0) return matrix;
  const out = new Float32Array(matrix);
  for (let column = 0; column < 4; column++) {
    const base = column * 4;
    const w = matrix[base + 3]!;
    out[base] = matrix[base]! * framing.scale + w * framing.offset[0];
    out[base + 1] = matrix[base + 1]! * framing.scale + w * framing.offset[1];
  }
  return out;
}

/** How much wider the wall must be so the shifted projection still covers it. */
export function framingCoverage(framing: ProjectionFraming): Vec2 {
  const scale = Math.max(framing.scale, 1e-4);
  return [
    Math.max(1, (1 + Math.abs(framing.offset[0])) / scale),
    Math.max(1, (1 + Math.abs(framing.offset[1])) / scale),
  ];
}

export function framedWallExtent(
  aspect: number,
  distance: number,
  framing: ProjectionFraming,
  fov = CAMERA_FOV_DEGREES
): Vec2 {
  const extent = wallExtent(aspect, distance, fov);
  const coverage = framingCoverage(framing);
  return [extent[0] * coverage[0], extent[1] * coverage[1]];
}

function projectedBounds(matrices: Float32Array[], points: [number, number, number][]): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const matrix of matrices) {
    for (const [x, y, z] of points) {
      const clipX = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
      const clipY = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
      const clipW = matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!;
      if (!Number.isFinite(clipW) || Math.abs(clipW) < 1e-6) continue;
      x0 = Math.min(x0, clipX / clipW);
      y0 = Math.min(y0, clipY / clipW);
      x1 = Math.max(x1, clipX / clipW);
      y1 = Math.max(y1, clipY / clipW);
    }
  }
  return [x0, y0, x1, y1].every(Number.isFinite) ? { x0, y0, x1, y1 } : { x0: -1, y0: -1, x1: 1, y1: 1 };
}

const fits = (bounds: Bounds, viewport: FramingViewport) =>
  bounds.x1 - bounds.x0 <= (viewport.right - viewport.left) * 2 &&
  bounds.y1 - bounds.y0 <= (viewport.bottom - viewport.top) * 2;

/**
 * The nearest distance at which the prism fits `viewport`, and the projection
 * shift that centres it there. Bounds are taken across the whole parallax range,
 * so the shape never drifts out of its box under the pointer.
 */
export function fitFraming(
  aspect: number,
  viewport: FramingViewport,
  fov = CAMERA_FOV_DEGREES
): { distance: number; framing: ProjectionFraming } {
  const boundsAt = (distance: number) => {
    const matrices: Float32Array[] = [];
    for (const orbitX of [-1, 0, 1]) {
      for (const orbitY of [-1, 0, 1]) {
        matrices.push(cameraView(aspect, orbitX, orbitY, distance, fov).viewProjection);
      }
    }
    return projectedBounds(matrices, MESH_POSITIONS);
  };

  let low = Math.max(1e-4, MIN_DISTANCE);
  let high = Math.max(low, MAX_DISTANCE);
  let bounds = boundsAt(high);
  for (let attempt = 0; attempt < 8 && !fits(bounds, viewport); attempt++) {
    high *= 2;
    bounds = boundsAt(high);
  }
  for (let step = 0; step < 32; step++) {
    const middle = (low + high) / 2;
    const candidate = boundsAt(middle);
    if (fits(candidate, viewport)) {
      high = middle;
      bounds = candidate;
    } else {
      low = middle;
    }
  }
  return {
    distance: high,
    framing: {
      scale: 1,
      offset: [
        viewport.left + viewport.right - 1 - (bounds.x0 + bounds.x1) / 2,
        1 - viewport.top - viewport.bottom - (bounds.y0 + bounds.y1) / 2,
      ],
    },
  };
}

/**
 * The part of the canvas an element covers, as fractions from the canvas's
 * top-left. Returns nothing when the element has no usable overlap, so the
 * caller can fall back to centring the prism.
 */
export function viewportWithinCanvas(
  canvas: DOMRect,
  element: DOMRect
): FramingViewport | undefined {
  if (!(canvas.width > 0) || !(canvas.height > 0)) return undefined;
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));
  const left = clamp(element.left - canvas.left, 0, canvas.width);
  const top = clamp(element.top - canvas.top, 0, canvas.height);
  const right = clamp(element.left + element.width - canvas.left, 0, canvas.width);
  const bottom = clamp(element.top + element.height - canvas.top, 0, canvas.height);
  if (right - left < 1 || bottom - top < 1) return undefined;
  return {
    left: left / canvas.width,
    top: top / canvas.height,
    right: right / canvas.width,
    bottom: bottom / canvas.height,
  };
}
