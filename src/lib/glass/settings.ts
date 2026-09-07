export interface HeroFractalCamera {
  readonly cameraRotation: readonly [number, number, number];
  readonly cameraDistance: readonly [number, number, number];
  readonly cameraTarget: readonly [number, number, number];
  readonly fov: number;
  readonly maxMouseRotation: number;
  readonly mouseLerp: number;
}
export interface HeroFractalMaterial {
  readonly baseColor: readonly [number, number, number];
  readonly roughness: number;
  readonly diffuseStrength: number;
  readonly specularStrength: number;
  readonly ambientStrength: number;
}
export interface HeroFractalGlass {
  readonly fractalScale: number;
  readonly orbScale: number;
  readonly orbOffsetY: number;
  readonly sphereMix: number;
  readonly ior: number;
  readonly reflectionStrength: number;
  readonly backOpacity: number;
  readonly absorption: readonly [number, number, number];
  readonly frostRadius: number;
  readonly dispersion: number;
  readonly iridescenceStrength: number;
  readonly iridescenceFrequency: number;
  readonly environmentRotation: readonly [number, number, number];
  readonly environmentExposure: number;
}

export const HERO_FRACTAL_CAMERA = {
  cameraRotation: [0, 0, 0],
  // Level with the prism. The old vector looked down onto the shape from
  // 14 degrees up, which is what made the backdrop read as a floor it stood
  // on; the wall behind it wants a camera looking straight at it.
  cameraDistance: [5.6, 0, 0],
  // The glass mesh stands on y = -0.333 and reaches y = 0.983, so its middle
  // is the height to look at.
  cameraTarget: [0, 0.325, 0],
  fov: 20,
  // vgpu's prism swings noticeably under the cursor. 5 degrees at a lerp of
  // 0.02 was imperceptible.
  maxMouseRotation: 9,
  mouseLerp: 0.09,
} satisfies HeroFractalCamera;
export const HERO_FRACTAL_MATERIAL = {
  baseColor: [71 / 255, 71 / 255, 71 / 255],
  roughness: 0.24,
  diffuseStrength: 0.19,
  specularStrength: 0.06,
  ambientStrength: 0.34,
} satisfies HeroFractalMaterial;
export const HERO_ORB_MATERIAL = {
  baseColor: [1, 1, 1],
  roughness: 0.25,
  diffuseStrength: 0.08,
  specularStrength: 1.6,
  ambientStrength: 0,
} satisfies HeroFractalMaterial;
export const HERO_FRACTAL_GLASS = {
  fractalScale: 0.72,
  orbScale: 0.6,
  orbOffsetY: 0.08,
  sphereMix: 1, // the page opens on the orb
  ior: 1.149,
  reflectionStrength: 0.71,
  backOpacity: 0.19,
  absorption: [74 / 255, 74 / 255, 74 / 255],
  frostRadius: 1.8,
  dispersion: 0.025,
  iridescenceStrength: 0.04,
  iridescenceFrequency: 2,
  environmentRotation: [0, -36, 0],
  environmentExposure: 1,
} satisfies HeroFractalGlass;
