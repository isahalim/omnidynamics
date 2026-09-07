import type { Draw, Effect, Geometry, Gpu, Surface, Target } from "vgpu";
import { draw, effect, frame, sampler, target } from "vgpu";
import { perspectiveCamera } from "vgpu/scene";

import type { HeroGlassAssets } from "./hero-glass-assets-core";
import heroFractalBackgroundDrawWgsl from "./hero-fractal-background-draw.wgsl";
import heroFractalMeshWgsl from "./hero-fractal-mesh.wgsl";
import heroFractalPresentWgsl from "./hero-fractal-present.wgsl";
import heroPrismCausticWgsl from "./hero-prism-caustic.wgsl";
import heroGlassTransmissionWgsl from "./hero-glass-transmission.wgsl";
import heroGlassWgsl from "./hero-glass.wgsl";
import {
  HERO_FRACTAL_GLASS,
  type HeroFractalCamera,
  type HeroFractalGlass,
  type HeroFractalMaterial,
} from "./settings";

const HERO_LIGHT_CLEAR = 210 / 255; // #d2ccc2, the wall the canvas fades up from
const GLASS_MODEL_MATRIX = modelMatrix(1, [0, 0, 0]);
/**
 * How the prism's shadow sits on the wall behind it.
 *
 * The backdrop used to be a floor and these were floor-space occlusion blobs.
 * The wall replaced it, so what is left is a cast shadow: offset from the
 * silhouette along the key light, and an unoffset contact term that hugs it.
 * Distances are in aspect-corrected screen units, where 1.0 is the canvas
 * height.
 */
export const HERO_WALL_SHADOW_DEFAULTS = {
  /**
   * Down and to the right, matching the key light high on the left. Small: the
   * prism is close to the wall, so most of the shadow stays behind it and only
   * a soft edge shows.
   */
  shadowOffset: [0.038, -0.030] as readonly [number, number],
  shadowSoftness: 0.11,
  shadowOpacity: 0.55,
  contactOpacity: 0.22,
  /** The penumbra spreads the silhouette a little past the shape itself. */
  shadowSpread: 1.02,
};

export type HeroWallShadow = typeof HERO_WALL_SHADOW_DEFAULTS;

/**
 * The spectral beam, as vgpu's exterior caustic node exposes it. Beam
 * geometry, Cauchy dispersion, light appearance and caustic compositing are
 * its four groups; the names here are its names.
 */
export const HERO_CAUSTIC_DEFAULTS = {
  /**
   * In wall units, where 1.0 is the canvas height. vgpu's 0.025 is in its own
   * beam-space; at this scale it draws a bar rather than a beam.
   */
  beamWidth: 0.009,
  baseIor: 1.2,
  /**
   * Spread about the mean index — see `indexOfRefraction`. Far wider than any
   * real glass, which is what opens the fan into vgpu's rainbow rather than
   * the few degrees physical dispersion would give.
   */
  dispersion: 0.055,
  beamOpacity: 1,
  edgeFalloff: 16,
  rainbowRate: 3.8,
  rainbowPower: 3.7,
  /**
   * vgpu's 1.9 and 0.86 are against its own HDR backdrop target. Ours composite
   * straight onto the wall, where those values buried the copy the fan falls
   * across; these keep the same spread with the text still readable through it.
   */
  strength: 1.35,
  coverage: 0.72,
};
export type HeroCaustic = typeof HERO_CAUSTIC_DEFAULTS;

type SceneOutput = Surface | Target;

/** Where a model interior sits inside the glass. */
export interface InteriorFit {
  readonly scale: number;
  readonly offset: readonly [number, number, number];
}

/** One selectable shape inside the prism. Every entry shares the mesh shader. */
export interface InteriorEntry {
  readonly draw: Draw;
  readonly meshMin: readonly [number, number, number];
  readonly meshMax: readonly [number, number, number];
  /**
   * Absent for vgpu's own fractal, which is authored in the prism's frame and
   * drawn as four face instances that fill it from the origin. Our model
   * meshes are single instances centred on their own bounds, so each needs
   * placing inside the glass.
   */
  readonly fit?: InteriorFit;
}

/**
 * The room a model interior is fitted into, as half-extents around the orb's
 * centre.
 *
 * The glass is not centred on the world origin: the tetrahedron stands on the
 * floor at y = -0.333 with its apex at y = 0.983, so a mesh centred on its own
 * bounds and scaled to fill the prism hangs out through the base — which is
 * what the humanoid did. The space inside is neither symmetric nor a sphere,
 * so a single radius either clips the tall meshes or shrinks the wide ones to
 * a smudge; these are per-axis limits, checked against all four models on the
 * rendered page. Height is the generous axis because the tetrahedron is
 * tallest through its middle, where the shapes sit.
 *
 * Fitting here also keeps the swap through the orb invisible: whichever mesh
 * is loaded, the placement below resolves to exactly the orb's transform at
 * full morph.
 */
const INTERIOR_HALF_EXTENTS = [0.34, 0.38, 0.34] as const;

/**
 * How far a model interior turns to follow the cursor, in radians.
 *
 * The camera's own orbit is a few degrees of parallax on the whole scene; this
 * is the shape itself turning, which is what makes it read as an object you
 * are looking around rather than a picture that shifts. Only models spin —
 * vgpu's fractal is a sphere at rest, where a spin would be invisible.
 */
const INTERIOR_SPIN_YAW = 0.46;
const INTERIOR_SPIN_PITCH = 0.24;

export interface HeroFractalScene {
  readonly present: Effect;
  readonly background: Draw;
  /** vgpu's "3-4 - draw exterior light": the beam in and the spectrum out. */
  readonly exteriorCaustic: Draw;
  /** vgpu's "6 - draw internal light", drawn after the back faces. */
  readonly internalCaustic: Draw;
  readonly glassBack: Draw;
  readonly fractal: Draw;
  readonly glassFront: Draw;
  readonly interior: Target;
  readonly sceneSampler: GPUSampler;
  readonly environmentSampler: GPUSampler;
  /** "fractal" plus any model registered via registerInterior. */
  readonly interiors: Map<string, InteriorEntry>;
  /** Key into interiors; the shape currently drawn and morphed. */
  activeInterior: string;
  /** The coming-soon pages show the beam; the landing page does not. */
  caustics: boolean;
  /** The coming-soon pages leave the glass empty. */
  showInterior: boolean;
}

export interface HeroFractalSceneSettings {
  readonly camera: Readonly<HeroFractalCamera>;
  readonly fractalMaterial: Readonly<HeroFractalMaterial>;
  readonly orbMaterial: Readonly<HeroFractalMaterial>;
  readonly glass: Readonly<HeroFractalGlass>;
  readonly time?: number;
  readonly view?: {
    readonly position: readonly [number, number, number];
    readonly target: readonly [number, number, number];
    readonly up: readonly [number, number, number];
    readonly fov: number;
    readonly pointer: readonly [number, number];
    readonly maxMouseRotation: number;
  };
  readonly wallShadow?: Readonly<HeroWallShadow>;
  readonly caustic?: Readonly<HeroCaustic>;
  readonly morphDirection?: number;
  readonly reflectionDebug?: boolean;
}

export interface HeroFractalFrameState {
  readonly viewProjection: Float32Array;
  readonly environmentRotation: Float32Array;
  readonly fractalModel: Float32Array;
  readonly sphereMix: number;
  readonly time: number;
}

export interface CameraFraming {
  /**
   * Pans the camera sideways, in world units, along its own right axis. The
   * prism sits at the origin, so panning the camera right slides the prism
   * left on screen. The canvas covers the whole viewport, so this is how a
   * page moves the prism out from behind the column its copy occupies.
   */
  readonly focus?: number;
  /**
   * Dollies the camera along its own view axis. The angle is untouched, so the
   * floor horizon holds its place and only the prism's share of the frame
   * changes.
   */
  readonly distanceScale?: number;
}

/** Places the camera for a page, keeping vgpu's measured angle and FOV. */
export function createCameraControls(
  camera: Readonly<HeroFractalCamera>,
  options: CameraFraming = {}
) {
  const { focus = 0, distanceScale = 1 } = options;
  const position = add3(
    camera.cameraTarget,
    scale3(rotateCamera(camera.cameraDistance, camera.cameraRotation), distanceScale)
  );
  const up = rotateCamera([0, 1, 0], camera.cameraRotation);
  const forward = normalize3(
    subtract3(camera.cameraTarget, position),
    [0, 0, -1]
  );
  const pan = scale3(normalize3(cross3(forward, up), [1, 0, 0]), focus);
  return {
    position: add3(position, pan),
    target: add3(camera.cameraTarget, pan),
    up,
    fov: camera.fov,
    maxMouseRotation: camera.maxMouseRotation,
    mouseLerp: camera.mouseLerp,
  };
}

/** Creates and compiles the production GPU scene shared by browser and headless rendering. */
export async function createHeroFractalScene(
  gpu: Gpu,
  output: SceneOutput,
  assets: HeroGlassAssets,
  label = "homepage-light"
): Promise<HeroFractalScene> {
  const scene = {
    present: effect(gpu, heroFractalPresentWgsl, {
      blend: "premultiplied",
      label: `${label}-fractal-present`,
    }),
    background: draw(gpu, {
      shader: heroFractalBackgroundDrawWgsl,
      vertices: 3,
      depth: false,
      label: `${label}-fractal-background`,
    }),
    exteriorCaustic: draw(gpu, {
      shader: heroPrismCausticWgsl,
      vertices: 3,
      depth: false,
      blend: "additive",
      label: `${label}-prism-caustic-exterior`,
    }),
    internalCaustic: draw(gpu, {
      shader: heroPrismCausticWgsl,
      vertices: 3,
      depth: false,
      blend: "additive",
      label: `${label}-prism-caustic-internal`,
    }),
    glassBack: draw(gpu, {
      shader: heroGlassWgsl,
      geometry: assets.geometry,
      cull: "front",
      depth: { write: false },
      blend: "premultiplied",
      label: `${label}-glass-back`,
    }),
    fractal: draw(gpu, {
      shader: heroFractalMeshWgsl,
      geometry: assets.fractalGeometry,
      instances: 4,
      cull: "back",
      label: `${label}-fractal-face-instances-l7`,
    }),
    glassFront: draw(gpu, {
      shader: heroGlassTransmissionWgsl,
      geometry: assets.geometry,
      cull: "back",
      depth: false,
      label: `${label}-glass-front-transmission`,
    }),
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
    environmentSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    }),
    interior: target(gpu, {
      size: output.size,
      format: output.format,
      depth: true,
      label: `${label}-fractal-glass-interior`,
    }),
    interiors: new Map<string, InteriorEntry>(),
    activeInterior: "fractal",
    caustics: false,
    showInterior: true,
  } satisfies HeroFractalScene;

  try {
    await Promise.all([
      scene.background.compile(scene.interior),
      scene.exteriorCaustic.compile(scene.interior),
      scene.internalCaustic.compile(scene.interior),
      scene.glassBack.compile(scene.interior),
      scene.fractal.compile(scene.interior),
      scene.glassFront.compile({ colors: [output.format] }),
      scene.present.compile({ colors: [output.format] }),
    ]);
    scene.interiors.set("fractal", {
      draw: scene.fractal,
      meshMin: assets.fractalMeshMin,
      meshMax: assets.fractalMeshMax,
    });
    return scene;
  } catch (error) {
    try {
      destroyHeroFractalScene(scene);
    } catch {
      // Preserve the compilation failure.
    }
    throw error;
  }
}

/** Applies the deterministic, input-free state used by the thumbnail renderer. */
export function setHeroFractalSceneSettings(
  scene: HeroFractalScene,
  assets: HeroGlassAssets,
  resolution: readonly [number, number],
  settings: HeroFractalSceneSettings
): HeroFractalFrameState {
  const { camera, fractalMaterial, orbMaterial, glass } = settings;
  const target = settings.view?.target ?? camera.cameraTarget;
  const up =
    settings.view?.up ?? rotateCamera([0, 1, 0], camera.cameraRotation);
  const basePosition =
    settings.view?.position ??
    add3(target, rotateCamera(camera.cameraDistance, camera.cameraRotation));
  const position = settings.view
    ? orbitCameraPosition(
        basePosition,
        target,
        up,
        settings.view.pointer,
        settings.view.maxMouseRotation
      )
    : basePosition;
  const fov = settings.view?.fov ?? camera.fov;
  const view = perspectiveCamera({
    fov,
    aspect: resolution[0] / Math.max(resolution[1], 1),
    near: 0.05,
    far: 20,
    position,
    target,
    up,
  });
  const materialMix = clamp01(glass.sphereMix);
  const interior =
    scene.interiors.get(scene.activeInterior) ??
    scene.interiors.get("fractal")!;
  // The active shape's own placement, blended toward the orb's as the morph
  // runs. Both resolve to the orb's transform at full morph, which is what lets
  // `setState` swap the mesh mid-flight without the swap being visible.
  const shapeScale = interior.fit?.scale ?? glass.fractalScale;
  const shapeOffset = interior.fit?.offset ?? ([0, 0, 0] as const);
  const innerScale =
    shapeScale * (1 - materialMix) + glass.orbScale * materialMix;
  const material = blendMaterial(fractalMaterial, orbMaterial, materialMix);
  const environmentRotation = environmentRotationMatrix(
    glass.environmentRotation
  );
  const pointer = settings.view?.pointer ?? [0, 0];
  // The shape turns toward the cursor, and unwinds as it morphs back to the
  // orb, where a rotation would have nothing to show.
  const spin = interior.fit ? 1 - materialMix : 0;
  const fractalModel = spinModelMatrix(
    innerScale,
    [
      shapeOffset[0] * (1 - materialMix),
      shapeOffset[1] * (1 - materialMix) + glass.orbOffsetY * materialMix,
      shapeOffset[2] * (1 - materialMix),
    ],
    -pointer[0] * INTERIOR_SPIN_YAW * spin,
    -pointer[1] * INTERIOR_SPIN_PITCH * spin
  );
  const time = settings.time ?? 0;

  // Where the prism lands on the wall, so the shadow pass can place itself
  // without reading depth. The glass mesh is not centred on the origin, so its
  // own bounds are projected rather than the origin.
  const shadow = settings.wallShadow ?? HERO_WALL_SHADOW_DEFAULTS;
  const footprint = projectPrismFootprint(
    view.viewProjectionMatrix,
    assets.meshMin,
    assets.meshMax,
    resolution
  );
  scene.background.set({
    wallMaterial: assets.wallMaterial,
    wallSampler: assets.wallSampler,
    params: {
      resolution,
      prismCenter: footprint.center,
      prismHalfExtent: [
        footprint.halfExtent[0] * shadow.shadowSpread,
        footprint.halfExtent[1] * shadow.shadowSpread,
      ],
      shadowOffset: shadow.shadowOffset,
      shadowSoftness: shadow.shadowSoftness,
      shadowOpacity: shadow.shadowOpacity,
      contactOpacity: shadow.contactOpacity,
    },
  });
  const caustic = settings.caustic ?? HERO_CAUSTIC_DEFAULTS;
  const causticParams = {
    resolution,
    prismCenter: footprint.center,
    prismHalfExtent: footprint.halfExtent,
    pointer,
    ...caustic,
  };
  scene.exteriorCaustic.set({ params: { ...causticParams, segment: 0 } });
  scene.internalCaustic.set({ params: { ...causticParams, segment: 1 } });

  const glassParams = {
    viewProjection: view.viewProjectionMatrix,
    model: GLASS_MODEL_MATRIX,
    cameraPosition: position,
    meshMin: assets.meshMin,
    meshMax: assets.meshMax,
    resolution,
    fractalScale: innerScale,
    ior: glass.ior,
    reflectionStrength: glass.reflectionStrength,
    backOpacity: glass.backOpacity,
    absorption: glass.absorption,
    frostRadius: glass.frostRadius,
    dispersion: glass.dispersion,
    iridescenceStrength: glass.iridescenceStrength,
    iridescenceFrequency: glass.iridescenceFrequency,
    environmentRotation,
    environmentExposure: glass.environmentExposure,
    reflectionDebug: settings.reflectionDebug ? 1 : 0,
  };
  scene.glassBack.set({
    params: glassParams,
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
  });
  interior.draw.set({
    params: {
      viewProjection: view.viewProjectionMatrix,
      model: fractalModel,
      cameraPosition: position,
      meshMin: interior.meshMin,
      meshMax: interior.meshMax,
      sphereMix: glass.sphereMix * (settings.morphDirection ?? 1),
      time,
      material,
      environmentRotation,
      environmentExposure: glass.environmentExposure,
    },
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
  });
  scene.glassFront.set({
    params: glassParams,
    environmentTexture: assets.environmentView,
    environmentSampler: scene.environmentSampler,
    sceneTexture: scene.interior,
    sceneSampler: scene.sceneSampler,
  });
  scene.present.set({ sceneTexture: scene.interior });
  return {
    viewProjection: view.viewProjectionMatrix as Float32Array,
    environmentRotation,
    fractalModel,
    sphereMix: glass.sphereMix * (settings.morphDirection ?? 1),
    time,
  };
}

export function renderHeroFractalScene(
  gpu: Gpu,
  output: SceneOutput,
  scene: HeroFractalScene,
  finalDebugDraws: readonly Draw[] = []
): void {
  frame(gpu, (currentFrame) => {
    currentFrame.pass(
      {
        target: scene.interior,
        clear: [HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, 1],
      },
      (pass) => {
        // vgpu's backdrop pass draws the wall and its shadow, then the exterior
        // light, then the glass back faces, then the internal light. Ours adds
        // the interior shape at the end, inside the glass.
        pass.draw(scene.background);
        if (scene.caustics) pass.draw(scene.exteriorCaustic);
        pass.draw(scene.glassBack);
        if (scene.caustics) pass.draw(scene.internalCaustic);
        if (scene.showInterior) {
          pass.draw(
            (scene.interiors.get(scene.activeInterior) ??
              scene.interiors.get("fractal")!).draw
          );
        }
      }
    );
    currentFrame.pass(
      {
        target: output,
        clear: [HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, HERO_LIGHT_CLEAR, 1],
      },
      (pass) => {
        pass.draw(scene.present);
        pass.draw(scene.glassFront);
        for (const debugDraw of finalDebugDraws) pass.draw(debugDraw);
      }
    );
  });
}

export function resizeHeroFractalScene(
  scene: HeroFractalScene,
  size: readonly [number, number]
): void {
  scene.interior.resize(size);
}

/**
 * Adds a model as a selectable interior. Models are authored as single-instance
 * meshes; only vgpu's own fractal uses the four tetrahedral face instances.
 */
export async function registerInterior(
  gpu: Gpu,
  scene: HeroFractalScene,
  id: string,
  geometry: Geometry,
  meshMin: readonly [number, number, number],
  meshMax: readonly [number, number, number]
): Promise<void> {
  if (scene.interiors.has(id)) return;
  const interiorDraw = draw(gpu, {
    shader: heroFractalMeshWgsl,
    geometry,
    instances: 1,
    cull: "back",
    label: `interior-${id}`,
  });
  await interiorDraw.compile(scene.interior);
  scene.interiors.set(id, {
    draw: interiorDraw,
    meshMin,
    meshMax,
    fit: interiorFit(meshMin, meshMax),
  });
}

/**
 * Scales a mesh uniformly until it fits `INTERIOR_HALF_EXTENTS` and lifts it to
 * the orb's height. Model meshes are centred on their own bounding box, so the
 * offset is the orb's and nothing else.
 */
/**
 * A model matrix that also turns the shape: yaw about Y, then pitch about X.
 *
 * The scale stays uniform, so the mesh shader's `model * vec4(normal, 0)` is
 * still a correct normal transform.
 */
function spinModelMatrix(
  scale: number,
  translation: readonly [number, number, number],
  yaw: number,
  pitch: number
): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  // Ry(yaw) * Rx(pitch), stored column-major and pre-scaled.
  return new Float32Array([
    scale * cy, 0, scale * -sy, 0,
    scale * sy * sx, scale * cx, scale * cy * sx, 0,
    scale * sy * cx, scale * -sx, scale * cy * cx, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

function interiorFit(
  meshMin: readonly [number, number, number],
  meshMax: readonly [number, number, number]
): InteriorFit {
  // Uniform scale, so the tightest axis is the one that binds.
  const scale = Math.min(
    ...INTERIOR_HALF_EXTENTS.map((limit, axis) => {
      const half = (meshMax[axis]! - meshMin[axis]!) / 2;
      return limit / (half || 1);
    })
  );
  return { scale, offset: [0, HERO_FRACTAL_GLASS.orbOffsetY, 0] };
}

/**
 * Projects the glass mesh's bounds to the wall plane: the centre the shadow is
 * cast from, and a radius that covers the silhouette.
 *
 * Returned in the same aspect-corrected screen units the wall pass works in —
 * origin at the canvas centre, y up, 1.0 across the canvas height — so the
 * shadow tracks the prism through a camera pan or dolly without the shader
 * needing the view matrix.
 */
function projectPrismFootprint(
  viewProjection: Float32Array,
  meshMin: readonly [number, number, number],
  meshMax: readonly [number, number, number],
  resolution: readonly [number, number]
): { center: [number, number]; halfExtent: [number, number] } {
  const aspect = resolution[0] / Math.max(resolution[1], 1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  // Every corner of the bounding box, so the footprint holds whatever way the
  // camera is pointed.
  for (let corner = 0; corner < 8; corner++) {
    const point: [number, number, number] = [
      corner & 1 ? meshMax[0] : meshMin[0],
      corner & 2 ? meshMax[1] : meshMin[1],
      corner & 4 ? meshMax[2] : meshMin[2],
    ];
    const clip = transformPoint(viewProjection, point);
    if (clip[3] <= 0.0001) continue;
    const x = (clip[0] / clip[3]) * 0.5 * aspect;
    const y = (clip[1] / clip[3]) * 0.5;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { center: [0, 0], halfExtent: [0.3, 0.3] };
  }
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2],
    halfExtent: [(maxX - minX) / 2, (maxY - minY) / 2],
  };
}

/** Column-major 4x4 times a point, returning clip space. */
function transformPoint(
  matrix: Float32Array,
  point: readonly [number, number, number]
): [number, number, number, number] {
  const [x, y, z] = point;
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
    matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!,
  ];
}

export function destroyHeroFractalScene(scene: HeroFractalScene): void {
  (scene.interior as Target & { destroy?: () => void }).destroy?.();
}

function blendMaterial(
  fractal: Readonly<HeroFractalMaterial>,
  orb: Readonly<HeroFractalMaterial>,
  mix: number
): HeroFractalMaterial {
  const interpolate = (a: number, b: number) => a * (1 - mix) + b * mix;
  return {
    baseColor: [
      interpolate(fractal.baseColor[0], orb.baseColor[0]),
      interpolate(fractal.baseColor[1], orb.baseColor[1]),
      interpolate(fractal.baseColor[2], orb.baseColor[2]),
    ],
    roughness: interpolate(fractal.roughness, orb.roughness),
    diffuseStrength: interpolate(fractal.diffuseStrength, orb.diffuseStrength),
    specularStrength: interpolate(
      fractal.specularStrength,
      orb.specularStrength
    ),
    ambientStrength: interpolate(fractal.ambientStrength, orb.ambientStrength),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function rotateCamera(
  vector: readonly [number, number, number],
  rotation: readonly [number, number, number]
): [number, number, number] {
  const cz = Math.cos(rotation[2]);
  const sz = Math.sin(rotation[2]);
  const rolled: [number, number, number] = [
    cz * vector[0] - sz * vector[1],
    sz * vector[0] + cz * vector[1],
    vector[2],
  ];
  const cx = Math.cos(rotation[0]);
  const sx = Math.sin(rotation[0]);
  const pitched: [number, number, number] = [
    rolled[0],
    cx * rolled[1] + sx * rolled[2],
    -sx * rolled[1] + cx * rolled[2],
  ];
  const cy = Math.cos(rotation[1]);
  const sy = Math.sin(rotation[1]);
  return [
    cy * pitched[0] + sy * pitched[2],
    pitched[1],
    -sy * pitched[0] + cy * pitched[2],
  ];
}

function add3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function modelMatrix(
  scale: number,
  translation: readonly [number, number, number]
): Float32Array {
  return new Float32Array([
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ]);
}

function orbitCameraPosition(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
  up: readonly [number, number, number],
  pointer: readonly [number, number],
  maxRotationDegrees: number
): readonly [number, number, number] {
  if (maxRotationDegrees === 0 || (pointer[0] === 0 && pointer[1] === 0)) {
    return position;
  }
  const maxRotation = (maxRotationDegrees * Math.PI) / 180;
  const upAxis = normalize3(up, [0, 1, 0]);
  const offset = subtract3(position, target);
  const yawedOffset = rotateAroundAxis(
    offset,
    upAxis,
    -pointer[0] * maxRotation
  );
  const rightAxis = normalize3(
    cross3(scale3(yawedOffset, -1), upAxis),
    [0, 0, 1]
  );
  return add3(
    target,
    rotateAroundAxis(yawedOffset, rightAxis, pointer[1] * maxRotation)
  );
}

function rotateAroundAxis(
  vector: readonly [number, number, number],
  axis: readonly [number, number, number],
  angle: number
): [number, number, number] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const projection = dot3(axis, vector) * (1 - cosine);
  const perpendicular = cross3(axis, vector);
  return [
    vector[0] * cosine + perpendicular[0] * sine + axis[0] * projection,
    vector[1] * cosine + perpendicular[1] * sine + axis[1] * projection,
    vector[2] * cosine + perpendicular[2] * sine + axis[2] * projection,
  ];
}

function normalize3(
  vector: readonly [number, number, number],
  fallback: readonly [number, number, number]
): [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 0.000001
    ? [...fallback]
    : [vector[0] / length, vector[1] / length, vector[2] / length];
}

function subtract3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale3(
  vector: readonly [number, number, number],
  scale: number
): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function environmentRotationMatrix(
  rotationDegrees: readonly [number, number, number]
): Float32Array {
  const toRadians = -Math.PI / 180;
  const rotation = rotationDegrees.map((value) => value * toRadians);
  const cx = Math.cos(rotation[0]!);
  const sx = Math.sin(rotation[0]!);
  const cy = Math.cos(rotation[1]!);
  const sy = Math.sin(rotation[1]!);
  const cz = Math.cos(rotation[2]!);
  const sz = Math.sin(rotation[2]!);

  return new Float32Array([
    cz * cy,
    sz * cy,
    -sy,
    0,
    cz * sy * sx - sz * cx,
    sz * sy * sx + cz * cx,
    cy * sx,
    0,
    cz * sy * cx + sz * sx,
    sz * sy * cx - cz * sx,
    cy * cx,
    0,
    0,
    0,
    0,
    1,
  ]);
}
