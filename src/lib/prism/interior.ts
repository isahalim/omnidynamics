/**
 * The platform held inside the glass.
 *
 * vgpu's glass-fractal example holds one shape in its tetrahedron and morphs it
 * between a fractal and an orb; the landing page holds a drone, a quadruped, a
 * manipulator or a humanoid, and morphs between them by passing through that
 * orb. Everything here is the example's — its mesh shader, its studio, its
 * morph, and its placement inside the solid — with a registry in front of it so
 * a mesh can be swapped while every shape is the same sphere.
 *
 * The placement is why the shape reads as being *in* the glass rather than
 * painted on it: it is authored in the tetrahedron's own coordinates, the ones
 * the example's optics trace, and the pyramid's model matrix carries the two
 * together into the world the wall lives in.
 */
import type { Draw, Gpu, Target } from "vgpu";
import { draw } from "vgpu";

import heroFractalMeshWgsl from "../glass/hero-fractal-mesh.wgsl";
import { decodeMesh } from "../glass/hero-glass-assets-core";
import {
  HERO_FRACTAL_GLASS,
  HERO_FRACTAL_MATERIAL,
  HERO_ORB_MATERIAL,
  type HeroFractalMaterial,
} from "../glass/settings";
import { PYRAMID_MODEL, pyramidInteriorScale } from "./pyramid";
import { multiply4, spinModelMatrix } from "./matrix";
import type { Vec3 } from "./constants";
import { BASE, withBase } from "../base";

const FRACTAL_MESH_URL = `${BASE}/glass/fractal-tetrahedron-l7.mesh`;
const MORPH_DURATION_MS = 1040;

/**
 * How far a model turns to follow the cursor, in radians. The camera's own
 * orbit is a few degrees of parallax on the whole scene; this is the shape
 * itself turning, which is what makes it read as an object you are looking
 * around. The orb is a sphere at rest, where a spin would be invisible.
 */
const SPIN_YAW = 0.46;
const SPIN_PITCH = 0.24;

export type PrismInteriorId = "fractal" | "drone" | "quadruped" | "manipulator" | "robot";

interface InteriorEntry {
  readonly draw: Draw;
  readonly meshMin: readonly [number, number, number];
  readonly meshMax: readonly [number, number, number];
  /** The scale this shape is drawn at before the morph blends toward the orb. */
  readonly scale: number;
  /** Where it sits in the tetrahedron's own frame. */
  readonly offset: Vec3;
  /** Only a model turns under the cursor. */
  readonly spins: boolean;
  /**
   * 1 when the geometry is a whole model mesh rather than the example's single
   * tetrahedron face. The example's morph is authored for that face — a tip-led
   * stagger across the radius range its vertices span, travelling to a sphere
   * target its own map produced — and a model run through it shears apart on
   * the way to the orb. A whole mesh morphs on one even progress, along the ray
   * its own sphere target lies on. See `hero-fractal-face-instance.wgsl`.
   */
  readonly wholeMesh: number;
}

export interface InteriorFrame {
  readonly viewProjection: Float32Array;
  readonly cameraPosition: Vec3;
  readonly environmentRotation: Float32Array;
  /** Where the cursor is, as -1 to 1 across the viewport. */
  readonly pointer: readonly [number, number];
}

export interface PrismInterior {
  /** True while the morph or the orb's own wobble still needs frames. */
  needsFrame(): boolean;
  bind(frame: InteriorFrame): void;
  /** What to draw this frame, back to front. */
  draws(): readonly Draw[];
  /** Advances the morph and the orb clock. */
  tick(time: number): void;
  setState(state: PrismInteriorId): Promise<void>;
  dispose(): void;
}

export async function createPrismInterior(
  gpu: Gpu,
  target: Target,
  environment: GPUTextureView,
  environmentSampler: GPUSampler,
  signal?: AbortSignal
): Promise<PrismInterior> {
  const entries = new Map<PrismInteriorId, InteriorEntry>();
  const meshes: { destroy?: () => void }[] = [];
  let disposed = false;
  /**
   * A second draw over the example's geometry, held at full sphere: the orb the
   * model is turning into, drawn inside it while it turns.
   *
   * A model mesh cannot close into a perfect sphere. These arrive from Spline
   * as hundreds of open pieces, and however evenly the morph target is spread
   * (see `scripts/build-meshes.mjs`) a few directions are left with no surface
   * in them, which shows mid-morph as the wall through a slit in the shape.
   * This is the shape's own destination, at the size the model resolves to, so
   * what shows through a slit is the orb rather than the plaster.
   */
  let orbDraw: Draw | undefined;

  const register = async (id: PrismInteriorId, url: string) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    signal?.throwIfAborted();
    const mesh = decodeMesh(gpu, buffer, `prism.hero.interior-${id}`);
    // The decoder also builds a line-list copy for the example's wireframe
    // debug view, which this page has no use for.
    (mesh.wireframeGeometry as { destroy?: () => void }).destroy?.();
    meshes.push(mesh.geometry);
    const isFractal = id === "fractal";
    const interiorDraw = draw(gpu, {
      shader: heroFractalMeshWgsl,
      geometry: mesh.geometry,
      // vgpu's fractal is one authored face, drawn over all four of the
      // tetrahedron's; our models are whole meshes.
      instances: isFractal ? 4 : 1,
      // The example's face is a clean closed surface, so it can be culled. The
      // model meshes are not — they arrive from Spline as hundreds of pieces
      // with open boundaries — and mid-morph the surface folds through itself,
      // where a culled back face leaves the wall showing through the shape as a
      // white slit. Drawing both sides costs a little fill and closes them.
      cull: isFractal ? "back" : "none",
      label: `prism.hero.interior-${id}`,
    });
    await interiorDraw.compile(target);
    if (isFractal) {
      orbDraw = draw(gpu, {
        shader: heroFractalMeshWgsl,
        geometry: mesh.geometry,
        instances: 4,
        cull: "back",
        label: "prism.hero.interior-orb-fill",
      });
      await orbDraw.compile(target);
    }
    entries.set(id, {
      draw: interiorDraw,
      meshMin: mesh.meshMin,
      meshMax: mesh.meshMax,
      scale: isFractal ? HERO_FRACTAL_GLASS.fractalScale : fitScale(mesh.meshMin, mesh.meshMax),
      // The fractal fills the solid from its centre; a model is centred on its
      // own bounds and stands where the orb does.
      offset: isFractal ? [0, 0, 0] : [0, HERO_FRACTAL_GLASS.orbOffsetY, 0],
      spins: !isFractal,
      wholeMesh: isFractal ? 0 : 1,
    });
  };

  await register("fractal", FRACTAL_MESH_URL);
  if (disposed) throw new Error("The interior was disposed while loading.");

  const inflight = new Map<PrismInteriorId, Promise<void>>();
  let current: PrismInteriorId = "fractal";
  let sphereMix = HERO_FRACTAL_GLASS.sphereMix; // the page opens on the orb
  let morphFrom = sphereMix;
  let morphTo = sphereMix;
  let morphDirection = 1;
  let morphStart = 0;
  let morphing = false;
  let orbTime = 0;
  let epoch = 0;

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const entry = () => entries.get(current) ?? entries.get("fractal")!;

  const tick = (time: number) => {
    if (!epoch) epoch = time;
    if (morphing) {
      const progress = Math.min(1, Math.max(0, (time - morphStart) / MORPH_DURATION_MS));
      sphereMix = morphFrom + (morphTo - morphFrom) * (1 - (1 - progress) ** 4);
      if (progress >= 1) {
        sphereMix = morphTo;
        morphing = false;
      }
    }
    // The orb's wobble is the only thing in the glass that moves on its own.
    if (sphereMix > 0) orbTime = (time - epoch) * 0.001;
  };

  /** How much of the orb fill is showing, 0 until the morph is well under way. */
  const fillAmount = () => {
    const active = entry();
    if (active.wholeMesh === 0 || sphereMix <= 0) return 0;
    // It has to stay inside the shape it is filling, and the shape is still
    // the model's own until the morph is most of the way through — so the fill
    // opens late and reaches the model's exact resolved size at the end.
    const t = Math.min(1, Math.max(0, (sphereMix - 0.42) / 0.33));
    return t * t * (3 - 2 * t);
  };

  const bind = (frame: InteriorFrame) => {
    const active = entry();
    const scale = active.scale * (1 - sphereMix) + HERO_FRACTAL_GLASS.orbScale * sphereMix;
    // Both shapes resolve to the orb's own transform at full morph, which is
    // what lets `setState` swap the mesh mid-flight without the swap showing.
    const offset: Vec3 = [
      active.offset[0] * (1 - sphereMix),
      active.offset[1] * (1 - sphereMix) + HERO_FRACTAL_GLASS.orbOffsetY * sphereMix,
      active.offset[2] * (1 - sphereMix),
    ];
    // Models turn toward the cursor and unwind as they morph back to the orb.
    const spin = active.spins ? 1 - sphereMix : 0;
    const model = multiply4(
      PYRAMID_MODEL,
      spinModelMatrix(
        scale,
        offset,
        -frame.pointer[0] * SPIN_YAW * spin,
        -frame.pointer[1] * SPIN_PITCH * spin
      )
    );
    const material = blendMaterial(HERO_FRACTAL_MATERIAL, HERO_ORB_MATERIAL, sphereMix);
    active.draw.set({
      params: {
        viewProjection: frame.viewProjection,
        model,
        cameraPosition: frame.cameraPosition,
        meshMin: active.meshMin,
        meshMax: active.meshMax,
        sphereMix: sphereMix * morphDirection,
        wholeMesh: active.wholeMesh,
        time: orbTime,
        material,
        environmentRotation: frame.environmentRotation,
        environmentExposure: HERO_FRACTAL_GLASS.environmentExposure,
      },
      environmentTexture: environment,
      environmentSampler,
    });

    const fill = fillAmount();
    if (fill > 0 && orbDraw) {
      const fractal = entries.get("fractal")!;
      orbDraw.set({
        params: {
          viewProjection: frame.viewProjection,
          model: multiply4(
            PYRAMID_MODEL,
            spinModelMatrix(scale * fill, offset, 0, 0)
          ),
          cameraPosition: frame.cameraPosition,
          meshMin: fractal.meshMin,
          meshMax: fractal.meshMax,
          sphereMix: 1,
          wholeMesh: 0,
          time: orbTime,
          material,
          environmentRotation: frame.environmentRotation,
          environmentExposure: HERO_FRACTAL_GLASS.environmentExposure,
        },
        environmentTexture: environment,
        environmentSampler,
      });
    }
  };

  const settleAt = (value: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (disposed || Math.abs(sphereMix - value) < 0.001) resolve();
        else requestAnimationFrame(check);
      };
      check();
    });

  const morphToward = (value: number) => {
    morphDirection = value >= sphereMix ? 1 : -1;
    morphFrom = sphereMix;
    morphTo = value;
    if (reduceMotion) {
      sphereMix = value;
      morphing = false;
      return Promise.resolve();
    }
    morphStart = performance.now();
    morphing = true;
    return settleAt(value);
  };

  let sequence = 0;
  const setState = async (state: PrismInteriorId) => {
    if (disposed || state === current) return;
    const token = ++sequence;

    // Every shape is the same sphere at full morph, so passing through the orb
    // makes the geometry swap invisible.
    await morphToward(1);
    if (disposed || token !== sequence) return;

    if (!entries.has(state)) {
      let pending = inflight.get(state);
      if (!pending) {
        pending = register(state, withBase(`/glass/models/${state}.mesh`));
        inflight.set(state, pending);
        pending.catch(() => inflight.delete(state));
      }
      await pending;
      if (disposed || token !== sequence) return;
    }
    current = state;
    if (state === "fractal") return;
    await morphToward(0);
  };

  return {
    needsFrame: () => morphing || sphereMix > 0,
    bind,
    draws: () =>
      fillAmount() > 0 && orbDraw ? [orbDraw, entry().draw] : [entry().draw],
    tick,
    setState,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) mesh.destroy?.();
    },
  };
}

/** The largest a model can be drawn and still clear every face of the glass. */
function fitScale(
  meshMin: readonly [number, number, number],
  meshMax: readonly [number, number, number]
): number {
  return pyramidInteriorScale(
    [
      (meshMax[0] - meshMin[0]) / 2,
      (meshMax[1] - meshMin[1]) / 2,
      (meshMax[2] - meshMin[2]) / 2,
    ],
    [0, HERO_FRACTAL_GLASS.orbOffsetY, 0]
  );
}

function blendMaterial(
  shape: Readonly<HeroFractalMaterial>,
  orb: Readonly<HeroFractalMaterial>,
  mix: number
): HeroFractalMaterial {
  const between = (a: number, b: number) => a * (1 - mix) + b * mix;
  return {
    baseColor: [
      between(shape.baseColor[0], orb.baseColor[0]),
      between(shape.baseColor[1], orb.baseColor[1]),
      between(shape.baseColor[2], orb.baseColor[2]),
    ],
    roughness: between(shape.roughness, orb.roughness),
    diffuseStrength: between(shape.diffuseStrength, orb.diffuseStrength),
    specularStrength: between(shape.specularStrength, orb.specularStrength),
    ambientStrength: between(shape.ambientStrength, orb.ambientStrength),
  };
}
