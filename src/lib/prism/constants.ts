/**
 * vgpu's light-pipeline constants, read from the shipped hero on vgpu.sh.
 *
 * Everything here is in vgpu's own units: the prism is an equilateral triangle
 * of side `PRISM_SIDE` centred on the origin, extruded between `PRISM_BACK_Z`
 * and `PRISM_FRONT_Z`, with the wall on z = 0 behind it.
 */
import { BASE } from "../base";


export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export const PRISM_SIDE = 0.57;
export const PRISM_FRONT_Z = 0.315;
export const PRISM_BACK_Z = 0.015;
/** The emissive sheet the light mesh is rasterised on, midway through the glass. */
export const PRISM_LIGHT_PLANE_Z = 0.165;
export const PRISM_CENTROID: Vec2 = [0, 0];
export const PRISM_MAX_INTERNAL_BOUNCES = 3;

export interface PrismTriangle {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly c: Vec2;
}

/** Apex up, wound counter-clockwise, inscribed in a circle of this radius. */
export const PRISM_TRIANGLE: PrismTriangle = (() => {
  const radius = PRISM_SIDE / Math.sqrt(3);
  const at = (degrees: number): Vec2 => {
    const angle = (degrees * Math.PI) / 180;
    return [
      PRISM_CENTROID[0] + radius * Math.cos(angle),
      PRISM_CENTROID[1] + radius * Math.sin(angle),
    ];
  };
  return { a: at(90), b: at(210), c: at(330) };
})();

/**
 * The landing page's glass: vgpu's rounded tetrahedron, from its glass-fractal
 * example, rather than the extruded prism the coming-soon pages hold.
 *
 * The example authors the solid as the unit-circumradius regular tetrahedron —
 * base on y = -1/3, apex on y = 1, one base vertex on +X — and renders it at the
 * origin, with its camera out on +X and raised. Its shaders trace that solid in
 * exactly those coordinates, so the mesh is left in them and a model matrix
 * carries it into the world this site's wall lives in: a quarter turn about Y,
 * bringing the +X base vertex round to face a camera on +Z, then scaled and
 * stood off the plaster by the clearance the prism keeps.
 */
export const PYRAMID_MESH_URL = `${BASE}/glass/rounded-tetrahedron.mesh`;

/** Circumradius, chosen so the silhouette covers what the prism's did. */
export const PYRAMID_CIRCUMRADIUS = 0.37;
/** Edge length, the pyramid's answer to `PRISM_SIDE`. */
export const PYRAMID_EDGE = PYRAMID_CIRCUMRADIUS * Math.sqrt(8 / 3);
/** Every face of the unit tetrahedron is this far from its centre. */
export const PYRAMID_UNIT_PLANE = 1 / 3;

/** Unit-tetrahedron corners, in the frame the example's shaders trace. */
export const PYRAMID_UNIT_CORNERS: readonly Vec3[] = [
  [0, 1, 0],
  [(2 * Math.SQRT2) / 3, -1 / 3, 0],
  [-Math.SQRT2 / 3, -1 / 3, Math.sqrt(6) / 3],
  [-Math.SQRT2 / 3, -1 / 3, -Math.sqrt(6) / 3],
];

/**
 * Where the pyramid sits in the wall's frame: the back corners keep the prism's
 * clearance from the plaster, and the silhouette is centred on the camera axis.
 */
export const PYRAMID_TRANSLATION: Vec3 = [
  0,
  -PYRAMID_CIRCUMRADIUS / 3,
  PRISM_BACK_Z + (PYRAMID_CIRCUMRADIUS * Math.SQRT2) / 3,
];

/** A quarter turn about Y: the example's +X base vertex round to +Z. */
export function pyramidTurn(vector: Vec3): Vec3 {
  return [-vector[2], vector[1], vector[0]];
}

/** The four corners in world units, which the cast shadow is projected from. */
export const PYRAMID_CORNERS: readonly Vec3[] = PYRAMID_UNIT_CORNERS.map(
  (corner) => {
    const turned = pyramidTurn(corner);
    return [0, 1, 2].map(
      (axis) => turned[axis]! * PYRAMID_CIRCUMRADIUS + PYRAMID_TRANSLATION[axis]!
    ) as unknown as Vec3;
  }
);

/**
 * The camera vgpu frames its glass-fractal example with, carried into this
 * world by the same quarter turn.
 *
 * Its 20 degree lens is most of why the example's tetrahedron reads as a solid
 * rather than a diagram: at the light pipeline's 48 the near base corner is
 * thrown forward hard enough to tear the shape inside it in two. The raise and
 * the small turn off the axis are what put the base in view and keep the two
 * lit faces unequal, which is the orientation the example is framed at.
 */
export const PYRAMID_CAMERA = (() => {
  const offset = pyramidTurn([5.44, 1.33, 0.55]);
  const length = Math.hypot(...offset);
  return {
    fov: 20,
    yawDegrees: (Math.atan2(offset[0], offset[2]) * 180) / Math.PI,
    pitchDegrees: (Math.asin(offset[1] / length) * 180) / Math.PI,
    /** Degrees of parallax under the pointer, as the example swings it. */
    orbitDegrees: 5,
  };
})();

export const CAMERA_DISTANCE = 1.25;
export const CAMERA_FOV_DEGREES = 48;
export const CAMERA_ORBIT_DEGREES = 3.5;
export const CAMERA_ORBIT_LERP = 0.08;
export const CAMERA_YAW_DEGREES = 0;
export const CAMERA_PITCH_DEGREES = 0;

export const PRISM_SPECTRAL_SAMPLES = 128;
export const PRISM_BEAM_SLICES = 24;
export const PRISM_WAVELENGTHS = { min: 400, max: 700 } as const;
export const PRISM_LIGHT_EXPOSURE = 88;
/** Where the lamp arc's midpoint puts the angle of incidence. */
export const PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES = 60;
export const PRISM_DEFAULT_ARC = 0.5;
export const PRISM_BEAM_WIDTH_RANGE = { min: 0.01, max: 0.2 } as const;

/** The two ends of the lamp's swing, in degrees of incidence. */
export const PRISM_BEAM_MOUSE_Y = { top: -35, bottom: 75 } as const;

/** vgpu's own hero runs the "stylized" preset overridden to these. */
export const PRISM_SPECTRAL_DISPERSION = { base: 1.2, strength: 0.1 } as const;

export const PRISM_LIGHT_FADE = {
  beamOpacity: 1,
  edgeFalloff: 16,
  rainbowFalloffRate: 3.8,
  rainbowFalloffPower: 3.7,
} as const;

/** The light theme's wall, glass and output controls. */
export const PRISM_WALL_COLOR = "#d2ccc2";

export const PRISM_LIGHT_MODE = {
  wall: {
    normalStrength: 0.6,
    lightmapGamma: 0.65,
    shadowContrast: 6.85,
    shadowPivot: 0.9,
    shadowFloor: 0.87,
    highlightExposure: 3.31,
    ambientFill: 0.42,
  },
  caustic: {
    strength: 1.9,
    coverage: 0.86,
    normalInfluence: 1,
    normalElevation: 35,
  },
  output: { exposure: 1, toneMapping: 0 },
} as const;

/** Fixed scales the light-mode controls multiply into. */
export const PRISM_WALL_TUNING = {
  materialScale: 2.4,
  normalStrength: 0.22,
  microNormalFrequency: 7,
  microNormalStrength: 1.05,
  ambient: 0.5,
  prismShadowStrength: 1,
  prismAoStrength: 1,
  groundingScale: 2,
} as const;

export const PRISM_CAUSTIC_TUNING = {
  farDesaturation: 0.04,
  farBrightness: 0.02,
  travelScale: 1,
  falloffRateScale: 0.12,
  falloffPowerScale: 0.5,
} as const;

export const PRISM_WALL_LIGHT_DIRECTION: Vec3 = [-0.48, 0.56, 0.68];

export const PRISM_GLASS = {
  ior: 1.645,
  absorption: [0, 0, 0] as Vec3,
  reflectionStrength: 3,
  environmentExposure: 4,
  environmentRotation: [0, 0, 0] as Vec3,
} as const;

export const PRISM_GLASS_ACCENT = {
  bandCenter: 0.052,
  bandWidth: 0.034,
  bandStrength: 0.52,
  baseReflection: 0.05,
  rimStrength: 0.45,
  baseRimStrength: 0.28,
  environmentLodBias: 1.6,
  highlightStrength: 0.95,
} as const;

/** The analytic cast-shadow mesh, in vgpu's own proportions. */
export const PRISM_SHADOW = {
  projection: [0.65 * PRISM_SIDE, -(0.78 * PRISM_SIDE)] as Vec2,
  nearPenumbra: 0.015 * PRISM_SIDE,
  farPenumbra: 0.1 * PRISM_SIDE,
  midRing: 0.48,
  midCoverage: 0.32,
  opacity: 0.46,
  farStrength: 0.92,
  color: [0.04, 0.037, 0.033] as Vec3,
} as const;

/**
 * The pyramid's front glass glow.
 *
 * The prism's accent measures its bands off the cross-section it was extruded
 * from, which a pyramid does not have; this one measures them off the solid's
 * own edges instead (see `glass-accent-pyramid.wgsl`). The bands are widened to
 * suit edges that run diagonally across a face rather than straight down it,
 * and the base rim is softened because the pyramid meets the wall at two corners
 * rather than along a whole face.
 */
/**
 * The pyramid's cast shadow.
 *
 * The key light is the prism's — the projection is its own lateral travel per
 * unit of depth, carried over the pyramid's deeper solid. Two things differ.
 * The penumbra is far wider, because the pyramid stands further off the wall
 * than the prism ever does, and the umbra is much lighter, because clear glass
 * does not stop light: most of what the silhouette covers arrives anyway, just
 * somewhere else. Where it lands is `PYRAMID_CAUSTIC`.
 */
export const PYRAMID_SHADOW = {
  projection: [
    (0.65 * PRISM_SIDE * (PYRAMID_CIRCUMRADIUS * Math.SQRT2)) /
      (PRISM_FRONT_Z - PRISM_BACK_Z),
    (-0.78 * PRISM_SIDE * (PYRAMID_CIRCUMRADIUS * Math.SQRT2)) /
      (PRISM_FRONT_Z - PRISM_BACK_Z),
  ] as Vec2,
  nearPenumbra: 0.05 * PYRAMID_EDGE,
  farPenumbra: 0.26 * PYRAMID_EDGE,
  midRing: PRISM_SHADOW.midRing,
  midCoverage: PRISM_SHADOW.midCoverage,
  opacity: 0.24,
  farStrength: 0.72,
  color: PRISM_SHADOW.color,
} as const;

/**
 * The light that comes through the glass and pools inside that shadow.
 *
 * The beam the pyramid intercepts leaves it turned rather than absorbed, so it
 * lands within the silhouette as a smaller, brighter figure of the same
 * outline. `focus` is how far in it contracts, `drift` how far along the key
 * light it then slides, and the glow is brightest along its own edge — the fold
 * the beam piles up on — which is what makes the shadow read as cast by
 * something you can see through.
 */
export const PYRAMID_CAUSTIC = {
  focus: 0.46,
  drift: 0.06,
  spread: 0.3 * PYRAMID_EDGE,
  rim: 0.42,
  midGlow: 0.14,
  midRing: 0.4,
  /** Slightly warm, as the wall's own light is. */
  color: [1, 0.965, 0.9] as Vec3,
  /**
   * Light added to plaster that is already near white, so it takes very little.
   * Enough to lift the middle of the shadow and no more: the silhouette still
   * has to read as a shadow, or the shape stops sitting in front of the wall.
   */
  strength: 0.18,
  falloff: 1.5,
} as const;

/**
 * The baked contact shadow and edge occlusion on the plaster behind the glass.
 *
 * The bake works in a local square two shape-widths across, with the shape's
 * own outline drawn into it; `wall-common.wgsl` samples it around
 * `prismCenter`. For the prism the outline is its cross-section. For the
 * pyramid it is the silhouette the solid casts straight back at the wall — the
 * apex and the two rear base corners — and its contact term is weakened,
 * because a pyramid touches the wall at two corners where the prism presents a
 * whole parallel face.
 */
export interface PrismGrounding {
  /** Where in the wall's frame the bake is centred. */
  readonly center: Vec2;
  /** How many world units across the baked square covers. */
  readonly scale: number;
  readonly apex: Vec2;
  readonly left: Vec2;
  readonly right: Vec2;
  readonly contactStrength: number;
}

export const PRISM_GROUNDING: PrismGrounding = {
  center: PRISM_CENTROID,
  scale: PRISM_SIDE * PRISM_WALL_TUNING.groundingScale,
  apex: [0, -0.5773502692] as Vec2,
  left: [-0.5, 0.2886751346] as Vec2,
  right: [0.5, 0.2886751346] as Vec2,
  contactStrength: 1,
};

export const PYRAMID_GROUNDING: PrismGrounding = {
  /** The outline's own centroid, so the bake sits under the silhouette. */
  center: [0, (-2 * PYRAMID_CIRCUMRADIUS) / 9] as Vec2,
  scale: PYRAMID_EDGE * PRISM_WALL_TUNING.groundingScale,
  apex: [0, -0.5443310540] as Vec2,
  left: [-0.5, 0.2721655270] as Vec2,
  right: [0.5, 0.2721655270] as Vec2,
  contactStrength: 0.35,
};

export const ENVIRONMENT_SIZE: Vec2 = [1024, 512];
export const ENVIRONMENT_MIP_LEVELS = 8;
export const ENVIRONMENT_TEXEL_ANGLE = (2 * Math.PI) / ENVIRONMENT_SIZE[0];

export const WALL_MATERIAL_SIZE: Vec2 = [512, 512];
export const WALL_LIGHTING_SIZE: Vec2 = [512, 512];
export const CAUSTIC_PROFILE_SIZE: Vec2 = [1024, 256];
/** vgpu's authored window-light mask, mirrored into this project's assets. */
export const WALL_LIGHT_MASK_URL = `${BASE}/prism/wall-global-light-mask.webp`;

export function clampBeamWidth(value: number): number {
  return Number.isFinite(value)
    ? Math.min(PRISM_BEAM_WIDTH_RANGE.max, Math.max(PRISM_BEAM_WIDTH_RANGE.min, value))
    : 0.025;
}

export const PRISM_BEAM_WIDTH = 0.025;
