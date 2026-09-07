/**
 * vgpu's light-pipeline constants, read from the shipped hero on vgpu.sh.
 *
 * Everything here is in vgpu's own units: the prism is an equilateral triangle
 * of side `PRISM_SIDE` centred on the origin, extruded between `PRISM_BACK_Z`
 * and `PRISM_FRONT_Z`, with the wall on z = 0 behind it.
 */

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

export const ENVIRONMENT_SIZE: Vec2 = [1024, 512];
export const ENVIRONMENT_MIP_LEVELS = 8;
export const ENVIRONMENT_TEXEL_ANGLE = (2 * Math.PI) / ENVIRONMENT_SIZE[0];

export const WALL_MATERIAL_SIZE: Vec2 = [512, 512];
export const WALL_LIGHTING_SIZE: Vec2 = [512, 512];
export const CAUSTIC_PROFILE_SIZE: Vec2 = [1024, 256];
/** vgpu's authored window-light mask, mirrored into this project's assets. */
export const WALL_LIGHT_MASK_URL = "/prism/wall-global-light-mask.webp";

export function clampBeamWidth(value: number): number {
  return Number.isFinite(value)
    ? Math.min(PRISM_BEAM_WIDTH_RANGE.max, Math.max(PRISM_BEAM_WIDTH_RANGE.min, value))
    : 0.025;
}

export const PRISM_BEAM_WIDTH = 0.025;
