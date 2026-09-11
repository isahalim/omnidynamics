/**
 * The platform held inside the glass.
 *
 * vgpu's glass-fractal example holds one shape in its tetrahedron and morphs it
 * between a fractal and an orb; the landing page holds a tesseract, a drone, a
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
import type { Draw, Geometry, Gpu, Target } from "vgpu";
import { draw } from "vgpu";

import heroFractalCoreWgsl from "../glass/hero-fractal-core.wgsl";
import heroFractalMeshWgsl from "../glass/hero-fractal-mesh.wgsl";
import { decodeMesh } from "../glass/hero-glass-assets-core";
import {
  HERO_CORE_LIGHT,
  HERO_FRACTAL_GLASS,
  HERO_FRACTAL_MATERIAL,
  HERO_GLOW_MATERIAL,
  HERO_ORB_MATERIAL,
  type HeroFractalMaterial,
} from "../glass/settings";
import { sphereGeometry } from "./geometry";
import { PYRAMID_MODEL, pyramidInteriorScale } from "./pyramid";
import { IDENTITY_4, multiply4, spinModelMatrix } from "./matrix";
import { PART_SLOTS, rigFor, type Rig } from "./rig";
import type { Vec3 } from "./constants";
import { BASE, withBase } from "../base";

const FRACTAL_MESH_URL = `${BASE}/glass/fractal-tetrahedron-l7.mesh`;
const MORPH_DURATION_MS = 1040;

/** No lamp: what every shape but the tesseract hands the shaders that read one. */
const NO_CORE = {
  position: [0, 0, 0] as Vec3,
  color: HERO_GLOW_MATERIAL.color,
  strength: 0,
  range: 1,
};

/**
 * How far a model turns to follow the cursor when it has no rig of its own, in
 * radians. The camera's own orbit is a few degrees of parallax on the whole
 * scene; this is the shape itself turning, which is what makes it read as an
 * object you are looking around. The orb is a sphere at rest, where a spin
 * would be invisible.
 */
const SPIN_YAW = 0.46;
const SPIN_PITCH = 0.24;

/** Every slot the shader poses, left as the identity. */
const REST_PARTS: Float32Array[] = Array.from({ length: PART_SLOTS }, () => IDENTITY_4);

export type PrismInteriorId =
  | "fractal"
  | "chronovoxel"
  | "drone"
  | "manipulator"
  | "robot";

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
  /** What its Spline scene does with it, or undefined for the example's face. */
  readonly rig: Rig | undefined;
  /**
   * 1 when the geometry is a whole model mesh rather than the example's single
   * tetrahedron face. The example's morph is authored for that face — a tip-led
   * stagger across the radius range its vertices span, travelling to a sphere
   * target its own map produced — and a model run through it shears apart on
   * the way to the orb. A whole mesh morphs on one even progress, along the ray
   * its own sphere target lies on. See `hero-fractal-face-instance.wgsl`.
   */
  readonly wholeMesh: number;
  /** True for the one shape with a lamp standing at its centre. */
  readonly lit: boolean;
}

export interface InteriorFrame {
  readonly viewProjection: Float32Array;
  readonly cameraPosition: Vec3;
  readonly environmentRotation: Float32Array;
  /** Where the cursor is, as -1 to 1 across the viewport. */
  readonly pointer: readonly [number, number];
}

/**
 * The lamp inside the shape as the glass around it sees it, in the world the
 * wall lives in — its own reach and its own falloff, not the ceramic's.
 */
export interface InteriorCoreLight {
  readonly position: Vec3;
  readonly color: readonly [number, number, number];
  readonly strength: number;
  readonly range: number;
}

export interface PrismInterior {
  /** True while the morph or the orb's own wobble still needs frames. */
  needsFrame(): boolean;
  bind(frame: InteriorFrame): void;
  /**
   * Where the lamp inside the shape stands this frame, for the glass around it
   * to catch — at no strength when what is in the glass has none. Read after
   * `bind`, which is what works it out.
   */
  coreLight(): InteriorCoreLight;
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
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  /** The lamp at the centre of the tesseract. See `hero-fractal-core.wgsl`. */
  let coreGeometry: Geometry | undefined;
  let coreDraw: Draw | undefined;
  let core: InteriorCoreLight = NO_CORE;

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
    const rig = isFractal ? undefined : rigFor(id, reduceMotion);
    entries.set(id, {
      draw: interiorDraw,
      meshMin: mesh.meshMin,
      meshMax: mesh.meshMax,
      scale: isFractal
        ? HERO_FRACTAL_GLASS.fractalScale
        : fitScale(mesh.meshMin, mesh.meshMax, rig),
      // The fractal fills the solid from its centre; a model is centred on its
      // own bounds and stands where the orb does.
      offset: isFractal ? [0, 0, 0] : [0, HERO_FRACTAL_GLASS.orbOffsetY, 0],
      spins: !isFractal,
      rig,
      wholeMesh: isFractal ? 0 : 1,
      lit: id === "chronovoxel",
    });
    if (id === "chronovoxel" && !coreDraw) await registerCore();
  };

  /**
   * The lamp, built once the shape that holds it arrives.
   *
   * It is light rather than a thing: added over what is already drawn, and
   * leaving the depth buffer as it found it, so the shells go on occluding one
   * another through it. It is depth-tested all the same — a shell standing in
   * front of the light hides the light, which is what makes the gaps between
   * the shells the only way it gets out.
   */
  const registerCore = async () => {
    coreGeometry = sphereGeometry(gpu, "prism.hero.interior-core");
    coreDraw = draw(gpu, {
      shader: heroFractalCoreWgsl,
      geometry: coreGeometry,
      cull: "back",
      blend: "additive",
      depth: { write: false },
      label: "prism.hero.interior-core",
    });
    await coreDraw.compile(target);
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
  // The rig's own clock, which unlike the orb's runs whatever is in the glass:
  // a propeller has to keep turning while the shape stands still.
  let rigTime = 0;
  let epoch = 0;

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
    rigTime = (time - epoch) * 0.001;
    // The orb's wobble is the only thing in the glass that moves on its own.
    if (sphereMix > 0) orbTime = rigTime;
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

  /**
   * The breath in the lamp's brightness.
   *
   * A light that is exactly as bright from one second to the next is a light
   * that was switched on; this is a tenth either way on a slow beat, which is
   * under the threshold at which you would call it flashing and over the one at
   * which the thing stops looking alive.
   */
  const corePulse = () =>
    1 + Math.sin(rigTime * HERO_CORE_LIGHT.pulse[1]) * HERO_CORE_LIGHT.pulse[0];

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
    // A rigged one does the rest of what its Spline scene does as well: the
    // whole subject leans and hovers, and each joint stands where the pose puts
    // it. Everything the rig returns is already faded out by the morph, so at
    // the orb the two shapes still meet as the same sphere.
    const spin = active.spins ? 1 - sphereMix : 0;
    const pose = active.rig?.pose(frame.pointer, rigTime, sphereMix);
    const model = multiply4(
      PYRAMID_MODEL,
      spinModelMatrix(
        scale,
        pose
          ? [
              offset[0] + pose.drift[0] * scale,
              offset[1] + pose.drift[1] * scale,
              offset[2] + pose.drift[2] * scale,
            ]
          : offset,
        pose ? pose.yaw : -frame.pointer[0] * SPIN_YAW * spin,
        pose ? pose.pitch : -frame.pointer[1] * SPIN_PITCH * spin,
        pose ? pose.roll : 0
      )
    );
    const material = blendMaterial(HERO_FRACTAL_MATERIAL, HERO_ORB_MATERIAL, sphereMix);
    // The shape is centred on its own bounds, so the lamp inside it stands at
    // the model matrix's own translation — the shape's centre, carried through
    // the lean, the drift and the pyramid in one. The scale it was carried
    // there by is the length of any of the matrix's axes, which is what turns
    // the lamp's own numbers, written in the mesh's units, into the world the
    // wall lives in.
    const worldScale = Math.hypot(model[0]!, model[1]!, model[2]!);
    // Two things put it out, and both have to.
    //
    // The first is the body it is inside. Shut, the tesseract is a solid box
    // and a box does not leak: not a trace of the light reaches the ceramic,
    // the glass or the air between them, and what stands in the pyramid is
    // black. As the clip turns the shells off one another the light gets out
    // through what has opened, slowly at first — `escape` is how far they have
    // to stand open before any of it does, and how far before all of it does.
    //
    // The second is the morph, which takes the shape to an orb that has no
    // inside to hold anything: the ball of light shrinks into the middle as its
    // own brightness goes down with it, so what leaves last is a glow rather
    // than a sphere that pops.
    const opened = pose
      ? smoothStep(HERO_CORE_LIGHT.escape[0], HERO_CORE_LIGHT.escape[1], pose.openness)
      : 1;
    const lit = active.lit ? (1 - sphereMix) * opened : 0;
    const shining = HERO_GLOW_MATERIAL.strength * corePulse() * lit;
    core = lit > 0
      ? {
          position: [model[12]!, model[13]!, model[14]!],
          color: HERO_GLOW_MATERIAL.color,
          strength: shining * HERO_CORE_LIGHT.glassReach,
          range: HERO_CORE_LIGHT.glassRange * worldScale,
        }
      : NO_CORE;
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
        // How hard the lamp lights the ceramic, and how far it carries there,
        // are both different questions from the same two asked of the glass —
        // so the shells are handed their own light rather than the glass's.
        core: {
          ...core,
          strength: shining * HERO_CORE_LIGHT.reach,
          range: HERO_CORE_LIGHT.range * worldScale,
        },
        environmentRotation: frame.environmentRotation,
        environmentExposure: HERO_FRACTAL_GLASS.environmentExposure,
        parts: pose ? pose.parts : REST_PARTS,
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
          core: NO_CORE,
          environmentRotation: frame.environmentRotation,
          environmentExposure: HERO_FRACTAL_GLASS.environmentExposure,
          parts: REST_PARTS,
        },
        environmentTexture: environment,
        environmentSampler,
      });
    }

    if (lit > 0 && coreDraw) {
      // The ball of light travels with the shape — the same lean, the same
      // drift — so it stays at the centre of the shells rather than sliding
      // about inside them. It is a sphere, so it takes the transform for the
      // ride and none of the turn shows.
      const breath = corePulse() * lit;
      coreDraw.set({
        params: {
          viewProjection: frame.viewProjection,
          model: multiply4(
            PYRAMID_MODEL,
            spinModelMatrix(
              scale * HERO_CORE_LIGHT.radius,
              pose
                ? [
                    offset[0] + pose.drift[0] * scale,
                    offset[1] + pose.drift[1] * scale,
                    offset[2] + pose.drift[2] * scale,
                  ]
                : offset,
              0,
              0
            )
          ),
          cameraPosition: frame.cameraPosition,
          color: core.color,
          // The glow is added over the image rather than tone mapped into it,
          // so both of these are in the range the image is already in: they are
          // the light it lays on, not an intensity to be mapped.
          centre: HERO_CORE_LIGHT.centre * breath,
          bloom: HERO_CORE_LIGHT.bloom * breath,
        },
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
    // A rig that moves on its own — a turning propeller, a hovering drone —
    // needs frames even when nothing has been touched and nothing is morphing.
    // So does a lamp that breathes.
    needsFrame: () =>
      morphing || sphereMix > 0 || entry().lit || (entry().rig?.animated ?? false),
    bind,
    coreLight: () => core,
    draws: () => {
      const list: Draw[] = [];
      if (fillAmount() > 0 && orbDraw) list.push(orbDraw);
      list.push(entry().draw);
      // The glow goes over the shells rather than among them: it is light in
      // the air, and the depth they wrote is what decides which of it gets out.
      if (core.strength > 0 && coreDraw) list.push(coreDraw);
      return list;
    },
    tick,
    setState,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) mesh.destroy?.();
      (coreGeometry as { destroy?: () => void } | undefined)?.destroy?.();
    },
  };
}

/**
 * The largest a model can be drawn and still clear every face of the glass — in
 * every pose it can hold, not only the one it was baked in.
 *
 * A rigged model is measured by the box its joints, its lean and its hover can
 * between them reach (see `rig.ts`), so a propeller that swings wider than the
 * airframe, or a drone that rises as it hovers, is inside the solid the whole
 * time rather than only at rest.
 */
function fitScale(
  meshMin: readonly [number, number, number],
  meshMax: readonly [number, number, number],
  rig?: Rig
): number {
  const centre: Vec3 = [0, HERO_FRACTAL_GLASS.orbOffsetY, 0];
  if (rig) return rig.fitScale(centre);
  return pyramidInteriorScale(
    [
      (meshMax[0] - meshMin[0]) / 2,
      (meshMax[1] - meshMin[1]) / 2,
      (meshMax[2] - meshMin[2]) / 2,
    ],
    centre
  );
}

/** The same ease the morph and the orb fill are shaped with. */
function smoothStep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
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
