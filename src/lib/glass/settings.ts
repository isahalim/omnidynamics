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
/** What the core inside the tesseract gives off. */
export interface HeroGlowMaterial {
  readonly color: readonly [number, number, number];
  readonly strength: number;
}
/**
 * The lamp itself: how big it is, how far its light carries, and what that
 * light does to the things around it.
 *
 * Every length is in the shape's own units, where the model it sits inside is
 * fitted to a radius of about one — so a radius of 0.22 is a body of light a
 * fifth of the shape across, standing in the middle of shells that reach out
 * four times as far.
 *
 * `centre` and `bloom` are the two numbers the glow is drawn with, and they are
 * in the range the image is already in rather than in light: the glow is added
 * over the scene, so `centre` is how much the middle of it lays on and `bloom`
 * the same for the corona around it. `centre` is deliberately past 1, where it
 * clips to white — see `hero-fractal-core.wgsl`.
 */
export interface HeroCoreLight {
  readonly radius: number;
  /**
   * How far it carries, to the ceramic and to the glass.
   *
   * They are two numbers rather than one because they are answers about two
   * distances. The shells are in among the light — the nearest is a tenth of
   * the shape from it — so what matters there is that it falls off hard enough
   * for the inner shells to be lit and the outer ones not. The glass stands
   * three times further out than anything in the body, and a falloff written
   * for the shells has nothing left by the time it gets there, so it would
   * either reach the glass or keep the tesseract black, and never both.
   */
  readonly range: number;
  readonly glassRange: number;
  /** How hard it lights the shells around it. */
  readonly reach: number;
  /** How hard it lights the glass it is standing in. */
  readonly glassReach: number;
  readonly centre: number;
  readonly bloom: number;
  /** How deep the breath in its brightness is, and how often it comes round. */
  readonly pulse: readonly [number, number];
  /**
   * How far the shells have to stand open before any of it gets out, and how
   * far before all of it does, as a share of the full turn the clip opens them
   * through. Shut, the body is light-tight: not a trace of it reaches the
   * ceramic, the glass or the air, and what is in the pyramid is a black box.
   */
  readonly escape: readonly [number, number];
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
  // In front of the prism's triangular face, level with it. The old vector sat
  // on +X, which is fine for a tetrahedron but shows the extrusion's flank on a
  // prism; and it used to look down 14 degrees, which made the backdrop read as
  // a floor rather than the wall behind.
  cameraDistance: [0, 0, 5.6],
  // The prism stands on y = -0.333 and reaches y = 0.983; its cross-section's
  // centroid is the height to look at, and the height the interior sits at.
  cameraTarget: [0, 0.10565, 0],
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
/**
 * The core inside the tesseract's shells.
 *
 * Every surface in the glass is the one dark ceramic, and this is the only
 * thing on the page that is its own light source. It is white, with the warmth
 * the room's own light has rather than the flat white of a screen — the wall,
 * its window and its caustic are all a little off neutral, and a light inside
 * the glass that was not would read as belonging to a different scene.
 */
export const HERO_GLOW_MATERIAL = {
  color: [1, 0.965, 0.925],
  strength: 2.4,
} satisfies HeroGlowMaterial;
/**
 * And what it is, as a body standing in the middle of the shells.
 *
 * `reach` and `glassReach` are the two numbers worth touching: the first is how
 * much of the core reaches the ceramic around it, the second how much of it
 * reaches the glass it is all standing in. Both are answers to the same
 * question — how much of a room a lamp lights — asked of two materials that
 * take light in quite different ways.
 */
export const HERO_CORE_LIGHT = {
  // Small. A body of light wide enough to stand behind the shells lays itself
  // over every one of them, which is the flat emissive answer again by another
  // route: what has to reach them is the light, not the lamp. The corona wants
  // a little room to fall away in, though, and the core inside it is held to a
  // third of this, so the part that is actually bright is smaller than the
  // number looks.
  radius: 0.52,
  // Short, inside the body. The light has to stay a local thing there — bright
  // in the crevice it is standing in and worth almost nothing by the outer
  // shell — or every surface takes the same amount of it and the tesseract
  // stops being a dark thing with a light in it. Out at the glass there is
  // nothing left to keep dark, so it carries three times as far and arrives as
  // a wash.
  range: 0.5,
  glassRange: 1.5,
  // And the ceramic takes little of what does reach it. It is the darkest
  // material on the page and it is meant to stay that way: what the light gives
  // it is an edge along a fold and a wash in a cavity, not a colour. White
  // carries further on a dark surface than a single channel does — every
  // channel it lands in is one the eye reads as brightness — so it takes rather
  // less of it than red did.
  reach: 0.22,
  // The glass takes the least of all. What it does with the light is not a
  // surface catching it but a screen laid over everything behind the face —
  // the shape included — so a share written as though the glass were a wall
  // washes out the tesseract itself and undoes the work above.
  glassReach: 0.12,
  // The core goes well past white, so the middle of it clips and reads as
  // something too bright to look at. The corona around it stays low, because
  // what it adds it adds over the far side of the body as well as over the
  // gaps, and the body is meant to stay dark.
  centre: 2.6,
  bloom: 0.2,
  pulse: [0.1, 0.62],
  escape: [0.2, 0.88],
} satisfies HeroCoreLight;
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
