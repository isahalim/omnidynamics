/**
 * The landing page's glass: vgpu's rounded tetrahedron, placed in the wall's
 * world.
 *
 * The mesh is vgpu's own asset from its glass-fractal example, decoded by that
 * example's decoder and left in that example's coordinates — its shaders trace
 * the solid analytically against the unit tetrahedron's four planes, so moving
 * the vertices would move the shape out from under its own optics. What moves
 * instead is a model matrix: a quarter turn about Y so the base vertex the
 * example points at its camera faces ours, scaled to `PYRAMID_CIRCUMRADIUS`,
 * and stood off the plaster by the clearance the prism keeps.
 *
 * Anything that has to reason about the solid in the world rather than through
 * it — the cast shadow, the framing search — uses `PYRAMID_CORNERS`, which is
 * that same matrix applied to the four corners.
 */
import type { Geometry, Gpu } from "vgpu";

import {
  PYRAMID_CAUSTIC,
  PYRAMID_CIRCUMRADIUS as R,
  PYRAMID_CORNERS,
  PYRAMID_MESH_URL,
  PYRAMID_SHADOW,
  PYRAMID_TRANSLATION as T,
  PYRAMID_UNIT_CORNERS,
  PYRAMID_UNIT_PLANE,
  type Vec3,
} from "./constants";
import {
  causticGeometryFrom,
  causticMeshDataFrom,
  shadowGeometryFrom,
  shadowHull,
  shadowMeshDataFrom,
} from "./geometry";
import { decodeMesh } from "../glass/hero-glass-assets-core";

export interface PyramidGlass {
  readonly geometry: Geometry;
  readonly meshMin: readonly [number, number, number];
  readonly meshMax: readonly [number, number, number];
  dispose(): void;
}

/**
 * The example's frame to ours, column-major: the quarter turn takes its +X to
 * our +Z, so the matrix's columns are the turned, scaled axes.
 */
export const PYRAMID_MODEL = new Float32Array([
  0, 0, R, 0,
  0, R, 0, 0,
  -R, 0, 0, 0,
  T[0], T[1], T[2], 1,
]);

/** Ours back to the example's, so its shaders can trace in their own frame. */
export const PYRAMID_MODEL_INVERSE = new Float32Array([
  0, 0, -1 / R, 0,
  0, 1 / R, 0, 0,
  1 / R, 0, 0, 0,
  -T[2] / R, -T[1] / R, T[0] / R, 1,
]);

export async function loadPyramidGlass(
  gpu: Gpu,
  signal?: AbortSignal
): Promise<PyramidGlass> {
  const response = await fetch(PYRAMID_MESH_URL, { signal });
  if (!response.ok)
    throw new Error(`Failed to load ${PYRAMID_MESH_URL}: HTTP ${response.status}`);
  const mesh = decodeMesh(gpu, await response.arrayBuffer(), "pyramid-glass");
  // The decoder also builds a line-list copy for the example's wireframe debug
  // view, which this page has no use for.
  (mesh.wireframeGeometry as { destroy?: () => void }).destroy?.();
  return {
    geometry: mesh.geometry,
    meshMin: mesh.meshMin,
    meshMax: mesh.meshMax,
    dispose() {
      (mesh.geometry as { destroy?: () => void }).destroy?.();
    },
  };
}

/**
 * The cast shadow, from the four corners rather than a cross-section and its
 * copy: each corner slides along the key light in proportion to how far it
 * stands off the wall, and the hull of the four is the umbra.
 */
export function pyramidShadowGeometry(gpu: Gpu, label: string): Geometry {
  const depth = pyramidDepth();
  return shadowGeometryFrom(
    gpu,
    shadowMeshDataFrom(PYRAMID_CORNERS, depth.back, depth.front, PYRAMID_SHADOW),
    label
  );
}

/** The pool of light that came through the glass, inside that shadow. */
export function pyramidCausticGeometry(gpu: Gpu, label: string): Geometry {
  const depth = pyramidDepth();
  const hull = shadowHull(
    PYRAMID_CORNERS,
    depth.back,
    depth.front,
    PYRAMID_SHADOW.projection
  );
  return causticGeometryFrom(
    gpu,
    causticMeshDataFrom(hull, PYRAMID_SHADOW.projection, PYRAMID_CAUSTIC),
    label
  );
}

function pyramidDepth(): { back: number; front: number } {
  const depths = PYRAMID_CORNERS.map((corner) => corner[2]!);
  return { back: Math.min(...depths), front: Math.max(...depths) };
}

/** The corners, for the projected-bounds framing search. */
export const PYRAMID_POSITIONS: [number, number, number][] = PYRAMID_CORNERS.map(
  (corner) => [corner[0], corner[1], corner[2]]
);

/**
 * The largest uniform scale at which a mesh of these half-extents, centred on
 * `centre`, still clears every face — all in the example's own frame.
 *
 * A box's furthest reach toward a plane is `|n·h|`, so the room each plane
 * leaves is its own distance from the centre divided by that; the tightest
 * plane binds, which for an upright model is usually the base.
 */
export function pyramidInteriorScale(
  half: readonly [number, number, number],
  centre: Vec3
): number {
  return interiorScale(
    centre,
    (normal) =>
      Math.abs(normal[0]) * half[0] +
      Math.abs(normal[1]) * half[1] +
      Math.abs(normal[2]) * half[2]
  );
}

/**
 * The same, for a shape given as points rather than a box.
 *
 * A model that moves is measured this way, because a box is much too blunt an
 * instrument for it: a shape that leans is still the same shape, but the box
 * around it grows in every direction at once, and fitting to that box would
 * shrink the platform to half its size for a lean of a few degrees. Asking each
 * face how far the points actually reach toward it costs one pass over the
 * poses and gives back the size the shape can honestly be drawn at.
 */
export function pyramidInteriorScalePoints(
  points: readonly (readonly [number, number, number])[],
  centre: Vec3
): number {
  return interiorScale(centre, (normal) => {
    let reach = 0;
    for (const point of points)
      reach = Math.max(
        reach,
        normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2]
      );
    return reach;
  });
}

/** The tightest of the four faces, given how far the shape reaches toward each. */
function interiorScale(centre: Vec3, reachToward: (normal: Vec3) => number): number {
  return Math.min(
    ...PYRAMID_UNIT_CORNERS.map((corner) => {
      // The face opposite a corner has that corner's direction as its inward
      // normal, and sits `PYRAMID_UNIT_PLANE` from the centre.
      const normal = corner.map((value) => -value) as unknown as Vec3;
      const room =
        PYRAMID_UNIT_PLANE -
        (normal[0] * centre[0] + normal[1] * centre[1] + normal[2] * centre[2]);
      return Math.max(0, room) / Math.max(reachToward(normal), 1e-6);
    })
  );
}
