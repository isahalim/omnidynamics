/**
 * The prism itself: an equilateral triangular cross-section with rounded
 * corners, extruded between `PRISM_BACK_Z` and `PRISM_FRONT_Z` and capped with a
 * rolled bevel at each end.
 *
 * Two triangular faces and three rectangular ones, exactly as vgpu builds it —
 * the rounding is what catches the studio key along every edge, so the shape
 * reads as solid glass rather than a flat silhouette.
 */
import type { Geometry, Gpu } from "vgpu";
import { geometry } from "vgpu";

import {
  PRISM_BACK_Z,
  PRISM_FRONT_Z,
  PRISM_SHADOW,
  PRISM_TRIANGLE,
  type PrismTriangle,
  type Vec2,
} from "./constants";

const normalize2 = (v: Vec2): Vec2 => {
  const length = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / length, v[1] / length];
};

/** Outward normal of the edge from `a` to `b` on a counter-clockwise polygon. */
const edgeNormal = (a: Vec2, b: Vec2): Vec2 => {
  const edge: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const length = Math.hypot(edge[0], edge[1]) || 1;
  return [edge[1] / length, -edge[0] / length];
};

interface ProfilePoint {
  readonly position: Vec2;
  readonly normal: Vec2;
}

/**
 * The rounded cross-section as a closed loop of points with outward normals:
 * five samples across each corner fillet, then fifteen along the straight edge
 * that follows it.
 */
function crossSectionProfile(triangle: PrismTriangle, radius: number): ProfilePoint[] {
  const corners = [triangle.a, triangle.b, triangle.c];
  const fillets = corners.map((corner, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length]!;
    const next = corners[(index + 1) % corners.length]!;
    const toPrevious = normalize2([previous[0] - corner[0], previous[1] - corner[1]]);
    const toNext = normalize2([next[0] - corner[0], next[1] - corner[1]]);
    const halfAngle =
      Math.acos(Math.min(1, Math.max(-1, toPrevious[0] * toNext[0] + toPrevious[1] * toNext[1]))) / 2;
    const tangentDistance = radius / Math.max(Math.tan(halfAngle), 1e-6);
    const centreDistance = radius / Math.max(Math.sin(halfAngle), 1e-6);
    const bisector = normalize2([toPrevious[0] + toNext[0], toPrevious[1] + toNext[1]]);
    const centre: Vec2 = [
      corner[0] + bisector[0] * centreDistance,
      corner[1] + bisector[1] * centreDistance,
    ];
    const start: Vec2 = [
      corner[0] + toPrevious[0] * tangentDistance,
      corner[1] + toPrevious[1] * tangentDistance,
    ];
    const end: Vec2 = [
      corner[0] + toNext[0] * tangentDistance,
      corner[1] + toNext[1] * tangentDistance,
    ];
    const startAngle = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
    let endAngle = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
    while (endAngle <= startAngle) endAngle += 2 * Math.PI;
    return Array.from({ length: 5 }, (_, step): ProfilePoint => {
      const angle = startAngle + ((endAngle - startAngle) * step) / 4;
      const direction: Vec2 = [Math.cos(angle), Math.sin(angle)];
      return {
        position: [centre[0] + direction[0] * radius, centre[1] + direction[1] * radius],
        normal: direction,
      };
    });
  });

  return fillets.flatMap((fillet, index) => {
    const last = fillet[fillet.length - 1]!;
    const nextStart = fillets[(index + 1) % fillets.length]![0]!;
    const normal = edgeNormal(corners[index]!, corners[(index + 1) % corners.length]!);
    return [
      ...fillet,
      ...Array.from({ length: 15 }, (_, step): ProfilePoint => {
        const t = (step + 1) / 16;
        return {
          position: [
            last.position[0] + (nextStart.position[0] - last.position[0]) * t,
            last.position[1] + (nextStart.position[1] - last.position[1]) * t,
          ],
          normal,
        };
      }),
    ];
  });
}

export interface PrismMeshData {
  readonly vertices: Float32Array;
  readonly indices: Uint16Array;
}

/**
 * Interleaved `position: float32x3, normal: float32x3`.
 *
 * The extrusion is swept as ten rings: five rolling the back bevel out to the
 * full cross-section, five rolling it back in at the front. Each ring insets the
 * profile along its own normal by `radius * (1 - cos a)` and tilts the normal by
 * the same angle, so the bevel is a quarter torus rather than a chamfer.
 */
export function prismMeshData(
  triangle: PrismTriangle = PRISM_TRIANGLE,
  backZ: number = PRISM_BACK_Z,
  frontZ: number = PRISM_FRONT_Z
): PrismMeshData {
  const radius = Math.min(0.008, 0.45 * Math.max(0, frontZ - backZ));
  const profile = crossSectionProfile(triangle, radius);

  const vertices: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];

  const push = (position: readonly number[], normal: readonly number[]): number => {
    const index = vertices.length / 6;
    vertices.push(...position, ...normal);
    return index;
  };

  const addRing = (angle: number, z: number, normalZ: number): number[] => {
    const inset = radius * (1 - Math.cos(angle));
    const lateral = Math.cos(angle);
    const ring = profile.map(({ position, normal }) =>
      push(
        [position[0] - normal[0] * inset, position[1] - normal[1] * inset, z],
        [normal[0] * lateral, normal[1] * lateral, normalZ]
      )
    );
    rings.push(ring);
    return ring;
  };

  // Stop just short of a right angle so the cap ring keeps a nonzero radius and
  // the fan that closes it has area.
  const maxAngle = Math.PI / 2 - 0.06;
  const sinMax = Math.sin(maxAngle);
  for (let step = 4; step >= 0; step--) {
    const angle = (maxAngle * step) / 4;
    addRing(angle, backZ + radius - (radius * Math.sin(angle)) / sinMax, -Math.sin(angle));
  }
  for (let step = 0; step <= 4; step++) {
    const angle = (maxAngle * step) / 4;
    addRing(angle, frontZ - radius + (radius * Math.sin(angle)) / sinMax, Math.sin(angle));
  }

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring]!;
    const upper = rings[ring + 1]!;
    for (let point = 0; point < profile.length; point++) {
      const next = (point + 1) % profile.length;
      indices.push(lower[point]!, lower[next]!, upper[next]!);
      indices.push(lower[point]!, upper[next]!, upper[point]!);
    }
  }

  const cap = (ring: number[], normal: readonly number[], reverse: boolean) => {
    const rim = ring.map((source) => {
      const offset = source * 6;
      return push([vertices[offset]!, vertices[offset + 1]!, vertices[offset + 2]!], normal);
    });
    const centre = push(
      [
        rim.reduce((sum, index) => sum + vertices[index * 6]!, 0) / rim.length,
        rim.reduce((sum, index) => sum + vertices[index * 6 + 1]!, 0) / rim.length,
        rim.reduce((sum, index) => sum + vertices[index * 6 + 2]!, 0) / rim.length,
      ],
      normal
    );
    for (let point = 0; point < rim.length; point++) {
      const next = (point + 1) % rim.length;
      if (reverse) indices.push(centre, rim[next]!, rim[point]!);
      else indices.push(centre, rim[point]!, rim[next]!);
    }
  };

  cap(rings[0]!, [0, 0, -1], true);
  cap(rings[rings.length - 1]!, [0, 0, 1], false);

  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

/** The five outward bounding planes as `(normal.xyz, offset)`: AB, BC, CA, front, back. */
export function prismPlanes(
  triangle: PrismTriangle = PRISM_TRIANGLE,
  backZ: number = PRISM_BACK_Z,
  frontZ: number = PRISM_FRONT_Z
): number[][] {
  const corners = [triangle.a, triangle.b, triangle.c];
  return [
    ...corners.map((corner, index) => {
      const [nx, ny] = edgeNormal(corner, corners[(index + 1) % 3]!);
      return [nx, ny, 0, nx * corner[0] + ny * corner[1]];
    }),
    [0, 0, 1, frontZ],
    [0, 0, -1, -backZ],
  ];
}

export function prismGeometry(gpu: Gpu, label: string): Geometry {
  const { vertices, indices } = prismMeshData();
  return geometry(gpu, {
    label,
    buffers: [
      {
        data: vertices,
        stride: 24,
        attributes: { position: "float32x3", normal: "float32x3" },
      },
    ],
    indices,
  });
}

/** Every mesh position, for the projected-bounds framing search. */
export function prismMeshPositions(): [number, number, number][] {
  const { vertices } = prismMeshData();
  const positions: [number, number, number][] = [];
  for (let index = 0; index < vertices.length; index += 6) {
    positions.push([vertices[index]!, vertices[index + 1]!, vertices[index + 2]!]);
  }
  return positions;
}

/** A solid's outline on the wall, with how far each point travelled to get there. */
export interface ShadowHull {
  readonly outline: Vec2[];
  readonly travel: number[];
}

/**
 * Where a solid's corners land on the wall.
 *
 * Every corner slides along the key light in proportion to how far it stands
 * off the plaster — `travel` 0 on the plane nearest the wall, 1 on the furthest
 * — and the hull of those wall points is the umbra. For the extruded prism that
 * is its cross-section and the copy of it the front face casts; for the pyramid
 * it is four corners at four different depths.
 */
export function shadowHull(
  corners: readonly (readonly [number, number, number])[],
  backZ: number,
  frontZ: number,
  projection: Vec2
): ShadowHull {
  const depth = frontZ - backZ || 1;
  const hull = convexHull(
    corners.map((corner) => {
      const travel = (corner[2] - backZ) / depth;
      return {
        position: [
          corner[0] + projection[0] * travel,
          corner[1] + projection[1] * travel,
        ] as Vec2,
        travel,
      };
    })
  );
  if (hull.length < 3) throw new Error("A cast-shadow hull needs three points.");
  return {
    outline: hull.map(({ position }) => position),
    travel: hull.map((point) => point.travel),
  };
}

/** The parts of a shadow's tuning the mesh itself is built from. */
export interface ShadowProfile {
  readonly projection: Vec2;
  readonly nearPenumbra: number;
  readonly farPenumbra: number;
  readonly midRing: number;
  readonly midCoverage: number;
}

/**
 * The cast shadow, as an analytic core with a penumbra skirt: the umbra hull,
 * with two offset rings around it carrying the coverage ramp. `travel` rides
 * along on each vertex, which is what lets the shader fade the shadow down its
 * length.
 */
export function shadowMeshDataFrom(
  corners: readonly (readonly [number, number, number])[],
  backZ: number,
  frontZ: number,
  shadow: ShadowProfile
): { vertices: Float32Array; indices: Uint32Array } {
  const { outline, travel } = shadowHull(corners, backZ, frontZ, shadow.projection);
  const penumbra = travel.map(
    (t) => shadow.nearPenumbra + (shadow.farPenumbra - shadow.nearPenumbra) * t
  );
  const midRing = offsetPolygon(outline, penumbra.map((width) => width * shadow.midRing));
  const outerRing = offsetPolygon(outline, penumbra);
  const centroid = polygonCentroid(outline);
  const meanTravel = travel.reduce((sum, value) => sum + value, 0) / travel.length;

  const vertices: number[] = [centroid[0], centroid[1], 1, meanTravel];
  const appendRing = (ring: Vec2[], coverage: number) => {
    ring.forEach((point, index) => vertices.push(point[0], point[1], coverage, travel[index]!));
  };
  appendRing(outline, 1);
  appendRing(midRing, shadow.midCoverage);
  appendRing(outerRing, 0);

  const count = outline.length;
  const midFirst = 1 + count;
  const outerFirst = midFirst + count;
  const indices: number[] = [];
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    indices.push(0, 1 + index, 1 + next);
    indices.push(1 + index, midFirst + index, midFirst + next);
    indices.push(1 + index, midFirst + next, 1 + next);
    indices.push(midFirst + index, outerFirst + index, outerFirst + next);
    indices.push(midFirst + index, outerFirst + next, midFirst + next);
  }

  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

/** The prism's own shadow: its cross-section at each end of the extrusion. */
export function prismShadowMeshData(
  triangle: PrismTriangle = PRISM_TRIANGLE,
  shadow = PRISM_SHADOW,
  backZ: number = PRISM_BACK_Z,
  frontZ: number = PRISM_FRONT_Z
): { vertices: Float32Array; indices: Uint32Array } {
  const corners = [triangle.a, triangle.b, triangle.c].flatMap(
    (corner) =>
      [
        [corner[0], corner[1], backZ],
        [corner[0], corner[1], frontZ],
      ] as [number, number, number][]
  );
  return shadowMeshDataFrom(corners, backZ, frontZ, shadow);
}

/** How the light that passes through the glass pools inside its own shadow. */
export interface CausticProfile {
  /** How far the pool contracts toward the umbra's centre. */
  readonly focus: number;
  /** How far it then slides on along the key light, as a share of the umbra. */
  readonly drift: number;
  /** How far the glow spreads past its own outline, in world units. */
  readonly spread: number;
  /** Brightness on its own outline, where the centre of the pool is 1. */
  readonly rim: number;
  /** Brightness partway out through the falloff. */
  readonly midGlow: number;
  readonly midRing: number;
}

/**
 * The caustic: a contracted, drifted copy of the umbra's own outline.
 *
 * A solid of clear glass does not stop the light behind it, it moves it — the
 * beam that entered the shape leaves it turned, and lands inside the shadow the
 * shape's silhouette casts as a smaller, brighter figure of itself. That is what
 * this mesh is: the same hull, pulled toward its centre and pushed along the
 * key light, brightest in the middle where the folded beam piles up, and fading
 * out through a skirt so it settles into the shadow rather than cutting it.
 */
export function causticMeshDataFrom(
  hull: ShadowHull,
  projection: Vec2,
  caustic: CausticProfile
): { vertices: Float32Array; indices: Uint32Array } {
  const centroid = polygonCentroid(hull.outline);
  const outline = hull.outline.map(
    (point): Vec2 => [
      centroid[0] + (point[0] - centroid[0]) * caustic.focus + projection[0] * caustic.drift,
      centroid[1] + (point[1] - centroid[1]) * caustic.focus + projection[1] * caustic.drift,
    ]
  );
  const widths = outline.map(() => caustic.spread);
  const midRing = offsetPolygon(outline, widths.map((width) => width * caustic.midRing));
  const outerRing = offsetPolygon(outline, widths);
  const centre = polygonCentroid(outline);

  const vertices: number[] = [centre[0], centre[1], 1];
  const appendRing = (ring: Vec2[], glow: number) => {
    for (const point of ring) vertices.push(point[0], point[1], glow);
  };
  appendRing(outline, caustic.rim);
  appendRing(midRing, caustic.midGlow);
  appendRing(outerRing, 0);

  const count = outline.length;
  const midFirst = 1 + count;
  const outerFirst = midFirst + count;
  const indices: number[] = [];
  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    indices.push(0, 1 + index, 1 + next);
    indices.push(1 + index, midFirst + index, midFirst + next);
    indices.push(1 + index, midFirst + next, 1 + next);
    indices.push(midFirst + index, outerFirst + index, outerFirst + next);
    indices.push(midFirst + index, outerFirst + next, midFirst + next);
  }

  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export function causticGeometryFrom(
  gpu: Gpu,
  { vertices, indices }: { vertices: Float32Array; indices: Uint32Array },
  label: string
): Geometry {
  return geometry(gpu, {
    label,
    buffers: [
      {
        data: vertices,
        stride: 12,
        attributes: { position: "float32x2", glow: "float32" },
      },
    ],
    indices,
  });
}

export function prismShadowGeometry(gpu: Gpu, label: string): Geometry {
  return shadowGeometryFrom(gpu, prismShadowMeshData(), label);
}

/** Uploads a shadow mesh in the layout `shadow.wgsl` reads. */
export function shadowGeometryFrom(
  gpu: Gpu,
  { vertices, indices }: { vertices: Float32Array; indices: Uint32Array },
  label: string
): Geometry {
  return geometry(gpu, {
    label,
    buffers: [
      {
        data: vertices,
        stride: 16,
        attributes: { position: "float32x2", coverage: "float32", travel: "float32" },
      },
    ],
    indices,
  });
}

interface HullPoint {
  readonly position: Vec2;
  readonly travel: number;
}

/** Monotone chain, keeping each point's travel alongside its position. */
function convexHull(points: HullPoint[]): HullPoint[] {
  const sorted = [...points].sort(
    (a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1]
  );
  const half = (input: HullPoint[]): HullPoint[] => {
    const chain: HullPoint[] = [];
    for (const point of input) {
      while (chain.length >= 2) {
        const a = chain.at(-2)!.position;
        const b = chain.at(-1)!.position;
        const c = point.position;
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-9) break;
        chain.pop();
      }
      chain.push(point);
    }
    return chain;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Pushes every vertex out along its own corner bisector by `widths[index]`. */
function offsetPolygon(polygon: Vec2[], widths: number[]): Vec2[] {
  return polygon.map((point, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const incoming = normalize2([point[0] - previous[0], point[1] - previous[1]]);
    const outgoing = normalize2([next[0] - point[0], next[1] - point[1]]);
    const incomingNormal: Vec2 = [incoming[1], -incoming[0]];
    const outgoingNormal: Vec2 = [outgoing[1], -outgoing[0]];
    const bisector = normalize2([
      incomingNormal[0] + outgoingNormal[0],
      incomingNormal[1] + outgoingNormal[1],
    ]);
    // Miter length, floored so a near-degenerate corner cannot shoot off.
    const miter =
      widths[index]! /
      Math.max(bisector[0] * outgoingNormal[0] + bisector[1] * outgoingNormal[1], 0.25);
    return [point[0] + bisector[0] * miter, point[1] + bisector[1] * miter] as Vec2;
  });
}

function polygonCentroid(polygon: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  let area = 0;
  for (let index = 0; index < polygon.length; index++) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    const cross = current[0] * next[1] - next[0] * current[1];
    x += (current[0] + next[0]) * cross;
    y += (current[1] + next[1]) * cross;
    area += cross;
  }
  const scale = 3 * area;
  return [x / scale, y / scale];
}
