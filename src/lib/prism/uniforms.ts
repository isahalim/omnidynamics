/** Uniform blocks for the light pipeline, assembled from vgpu's own control set. */
import { rotationMatrix } from "./camera";
import {
  ENVIRONMENT_SIZE,
  ENVIRONMENT_TEXEL_ANGLE,
  PRISM_BACK_Z,
  PRISM_CAUSTIC_TUNING,
  PRISM_FRONT_Z,
  PRISM_GLASS,
  PRISM_GROUNDING,
  PRISM_LIGHT_FADE,
  PRISM_LIGHT_MODE,
  PRISM_LIGHT_PLANE_Z,
  PRISM_SHADOW,
  PRISM_SIDE,
  PRISM_TRIANGLE,
  PRISM_WALL_COLOR,
  PRISM_WALL_LIGHT_DIRECTION,
  PRISM_WALL_TUNING,
  PYRAMID_GROUNDING,
  type PrismGrounding,
  type Vec2,
  type Vec3,
} from "./constants";
import { prismPlanes } from "./geometry";
import type { LightMeshLayout } from "./light-mesh";
import { LIGHT_INTERNAL_SEGMENTS } from "./light-mesh";

const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);
const PRISM_PLANES = prismPlanes();

/**
 * What the wall needs to know about which solid stands in front of it: where
 * its baked contact shadow and occlusion sit on the plaster, and how wide that
 * bake is. The coming-soon pages use the prism's; the landing page's pyramid
 * has its own silhouette.
 */
export interface PrismShape {
  readonly grounding: PrismGrounding;
}

export const PRISM_SHAPE: PrismShape = { grounding: PRISM_GROUNDING };
export const PYRAMID_SHAPE: PrismShape = { grounding: PYRAMID_GROUNDING };

function hexToRgb(hex: string): Vec3 {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) return [0.87, 0.87, 0.87];
  return [
    Number.parseInt(match[1]!, 16) / 255,
    Number.parseInt(match[2]!, 16) / 255,
    Number.parseInt(match[3]!, 16) / 255,
  ];
}

export const WALL_COLOR_RGB = hexToRgb(PRISM_WALL_COLOR);

export interface FrameState {
  readonly viewProjection: Float32Array;
  readonly cameraPosition: Vec3;
  readonly wallHalfExtent: Vec2;
  readonly beamDirection: Vec2;
  readonly layout: LightMeshLayout;
  /** 0 to 1 while the hero fades up; 1 once settled. */
  readonly revealProgress: number;
  readonly beamWidthReveal: number;
}

/** The wall needs only these two of a frame's numbers. */
export interface WallFrame {
  readonly viewProjection: Float32Array;
  readonly wallHalfExtent: Vec2;
}

export function lightWallUniforms(state: WallFrame, shape: PrismShape = PRISM_SHAPE) {
  const wall = PRISM_LIGHT_MODE.wall;
  const tuning = PRISM_WALL_TUNING;
  return {
    viewProjection: state.viewProjection,
    wallHalfExtent: state.wallHalfExtent,
    wallColor: WALL_COLOR_RGB,
    prismCenter: shape.grounding.center,
    lightDirection: PRISM_WALL_LIGHT_DIRECTION,
    materialWorldScale: PRISM_SIDE * tuning.materialScale,
    normalStrength: tuning.normalStrength * wall.normalStrength,
    microNormalFrequency: tuning.microNormalFrequency,
    microNormalStrength: tuning.microNormalStrength * wall.normalStrength,
    ambient: tuning.ambient,
    ambientLightStrength: wall.ambientFill,
    globalLightTransfer: wall.lightmapGamma,
    shadowContrast: wall.shadowContrast,
    shadowPivot: wall.shadowPivot,
    shadowFloor: wall.shadowFloor,
    highlightExposure: wall.highlightExposure,
    // The analytic shadow mesh owns the cast shadow; the mask only supplies AO.
    prismShadowStrength: 0,
    prismAoStrength: tuning.prismAoStrength,
    groundingScale: shape.grounding.scale,
  };
}

export function prismShadowUniforms(
  viewProjection: Float32Array,
  shadow: {
    readonly color: Vec3;
    readonly opacity: number;
    readonly farStrength: number;
  } = PRISM_SHADOW
) {
  return {
    viewProjection,
    color: shadow.color,
    opacity: shadow.opacity,
    farStrength: shadow.farStrength,
  };
}

export function sceneUniforms(state: FrameState) {
  const { layout } = state;
  return {
    viewProjection: state.viewProjection,
    wallHalfExtent: state.wallHalfExtent,
    inputBeamDirection: state.beamDirection,
    wallColor: WALL_COLOR_RGB,
    causticOnly: 0,
    lightPlaneZ: PRISM_LIGHT_PLANE_Z,
    lightWhiteQuads: layout.whiteQuads,
    lightBeamSlices: layout.beamSlices,
    lightSpectralSamples: layout.samples,
    lightInternalQuads: layout.internalQuads,
    lightInternalSegments: LIGHT_INTERNAL_SEGMENTS,
    lightOpacity: PRISM_LIGHT_FADE.beamOpacity,
    lightEdgeFalloff: PRISM_LIGHT_FADE.edgeFalloff,
    rainbowFalloffRate: PRISM_LIGHT_FADE.rainbowFalloffRate,
    rainbowFalloffPower: PRISM_LIGHT_FADE.rainbowFalloffPower,
    beamWidthReveal: Math.min(1, Math.max(0, state.beamWidthReveal)),
  };
}

export function lightCausticUniforms() {
  const caustic = PRISM_LIGHT_MODE.caustic;
  const wall = PRISM_LIGHT_MODE.wall;
  const tuning = PRISM_WALL_TUNING;
  return {
    strength: caustic.strength,
    coverage: caustic.coverage,
    farDesaturation: PRISM_CAUSTIC_TUNING.farDesaturation,
    farBrightness: PRISM_CAUSTIC_TUNING.farBrightness,
    travelScale: PRISM_CAUSTIC_TUNING.travelScale,
    falloffRateScale: PRISM_CAUSTIC_TUNING.falloffRateScale,
    falloffPowerScale: PRISM_CAUSTIC_TUNING.falloffPowerScale,
    materialWorldScale: PRISM_SIDE * tuning.materialScale,
    normalStrength: tuning.normalStrength * wall.normalStrength,
    microNormalFrequency: tuning.microNormalFrequency,
    microNormalStrength: tuning.microNormalStrength * wall.normalStrength,
    normalInfluence: caustic.normalInfluence,
    normalElevation: caustic.normalElevation,
  };
}

export function glassUniforms(state: FrameState) {
  const glass = PRISM_GLASS;
  const ior = Math.fround(glass.ior);
  const f0 = Math.fround(Math.fround(ior - 1) / Math.fround(ior + 1));
  return {
    viewProjection: state.viewProjection,
    environmentRotation: ENVIRONMENT_ROTATION,
    cameraPosition: state.cameraPosition,
    absorption: glass.absorption,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    environmentSize: ENVIRONMENT_SIZE,
    frontZ: PRISM_FRONT_Z,
    backZ: PRISM_BACK_Z,
    ior: glass.ior,
    reflectionStrength: glass.reflectionStrength,
    environmentExposure: glass.environmentExposure,
    environmentDebug: 0,
    environmentTexelAngle: ENVIRONMENT_TEXEL_ANGLE,
    fresnelF0: Math.fround(f0 * f0),
    prismPlanes: PRISM_PLANES,
  };
}

export function lightPresentUniforms(revealProgress: number) {
  return {
    backgroundColor: WALL_COLOR_RGB,
    exposure: PRISM_LIGHT_MODE.output.exposure,
    revealProgress: Math.min(1, Math.max(0, revealProgress)),
    toneMapping: PRISM_LIGHT_MODE.output.toneMapping,
  };
}
