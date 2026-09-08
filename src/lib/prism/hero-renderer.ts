/**
 * The landing page's hero: vgpu's glass-fractal tetrahedron, standing on this
 * site's lit wall.
 *
 * Two of vgpu's examples meet here. The wall, its window light, the cast shadow
 * and the baked contact occlusion are the light pipeline's — the same plaster
 * the coming-soon pages are lit on, drawn by the same shaders from the same
 * bakes. The glass and everything inside it are the glass-fractal example's:
 * its rounded tetrahedron, its screen-space transmission, its studio cubemap,
 * its 20 degree camera raised off the axis. The beam and the spectrum the
 * coming-soon pages carry are not here — the glass holds a platform instead,
 * and a rainbow across it would read as a second subject.
 *
 * The two pass structures agree, which is what lets them be composed at all.
 * vgpu's glass reads a resolved image of everything behind it and refracts it,
 * so the wall, the shadow, the glass's own back faces and the platform are all
 * drawn into one target first, and the front interface samples that. Its
 * material composites in display space, so the wall is tone mapped where it is
 * drawn rather than at the end.
 */
import type { Draw, Effect, Gpu, Surface, Target } from "vgpu";
import { draw, effect, frame, sampler, surface, target, init } from "vgpu";

import heroFractalPresentWgsl from "../glass/hero-fractal-present.wgsl";
import heroGlassWgsl from "../glass/hero-glass.wgsl";
import heroGlassTransmissionWgsl from "../glass/hero-glass-transmission.wgsl";
import { loadStudioCubemap } from "../glass/hero-glass-assets";
import { HERO_FRACTAL_GLASS } from "../glass/settings";

import heroCausticWgsl from "./hero-caustic.wgsl";
import shadowWgsl from "./shadow.wgsl";
import wallPresentedWgsl from "./wall-presented.wgsl";

import { createPrismAssets, type PrismAssets } from "./assets";
import { cameraView, rotationMatrix, type CameraOrientation } from "./camera";
import {
  CAMERA_ORBIT_LERP,
  PYRAMID_CAMERA,
  PYRAMID_CAUSTIC,
  PYRAMID_SHADOW,
  type Vec2,
} from "./constants";
import {
  IDENTITY_FRAMING,
  applyProjectionFraming,
  fitFraming,
  framedWallExtent,
  viewportWithinCanvas,
  type ProjectionFraming,
} from "./framing";
import { createPrismInterior, type PrismInterior, type PrismInteriorId } from "./interior";
import { followPointer } from "./pointer";
import {
  PYRAMID_MODEL,
  PYRAMID_MODEL_INVERSE,
  PYRAMID_POSITIONS,
  loadPyramidGlass,
  pyramidCausticGeometry,
  pyramidShadowGeometry,
  type PyramidGlass,
} from "./pyramid";
import { PYRAMID_SHAPE, WALL_COLOR_RGB, lightWallUniforms, prismShadowUniforms } from "./uniforms";

const CAMERA_ORIENTATION: CameraOrientation = {
  yawDegrees: PYRAMID_CAMERA.yawDegrees,
  pitchDegrees: PYRAMID_CAMERA.pitchDegrees,
  orbitDegrees: PYRAMID_CAMERA.orbitDegrees,
};
const CAMERA_FOV = PYRAMID_CAMERA.fov;
/** Far enough back that the fit always has room to search inward. */
const DEFAULT_DISTANCE = 2.4;

/**
 * The example rotates its studio by negative degrees; `rotationMatrix` takes
 * positive ones, so the sign is flipped here rather than in a second copy of
 * the same matrix.
 */
const ENVIRONMENT_ROTATION = rotationMatrix(
  HERO_FRACTAL_GLASS.environmentRotation.map((degrees) => -degrees) as unknown as
    readonly [number, number, number]
);

export interface HeroRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /**
   * Element whose box the glass is fitted into. The canvas still covers the
   * whole viewport — this only says where in it the shape belongs.
   */
  readonly frame?: HTMLElement;
}

export interface HeroRenderer {
  readonly ready: Promise<void>;
  /** Morphs to another platform inside the glass, through the orb. */
  setState(state: PrismInteriorId): Promise<void>;
  /**
   * Puts the scene back on screen after the browser restored the page from its
   * back/forward cache, where nothing was disposed but no frame was ever asked
   * for again. Re-measuring is what a restore may actually need — the window
   * can have been resized while the page was away.
   */
  resume(): void;
  dispose(): void;
}

export function createHeroRenderer(options: HeroRendererOptions): HeroRenderer {
  const abort = new AbortController();
  let disposed = false;

  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let assets: PrismAssets | undefined;
  let glass: PyramidGlass | undefined;
  let studio: { texture: { destroy?: () => void }; view: GPUTextureView } | undefined;
  let interior: PrismInterior | undefined;
  let backdrop: Target | undefined;
  let sceneSampler: GPUSampler | undefined;
  let environmentSampler: GPUSampler | undefined;
  let draws:
    | {
        wall: Draw;
        castShadow: Draw;
        caustic: Draw;
        glassBack: Draw;
        present: Effect;
        glassFront: Draw;
      }
    | undefined;

  let aspect = 1;
  let cameraDistance = DEFAULT_DISTANCE;
  let framing: ProjectionFraming = IDENTITY_FRAMING;
  let orbit: Vec2 = [0, 0];
  let pointerTarget: Vec2 = [0, 0];
  let wallHalfExtent: Vec2 = [1, 1];

  let animationFrame = 0;
  let visible = true;

  const viewportFor = () => {
    if (!options.frame) return undefined;
    return viewportWithinCanvas(
      options.canvas.getBoundingClientRect(),
      options.frame.getBoundingClientRect()
    );
  };

  /** Re-solves camera distance and projection shift for the current canvas. */
  const reframe = () => {
    const viewport = viewportFor();
    if (!viewport) {
      cameraDistance = DEFAULT_DISTANCE;
      framing = IDENTITY_FRAMING;
    } else {
      const fit = fitFraming(
        aspect,
        viewport,
        PYRAMID_POSITIONS,
        CAMERA_FOV,
        CAMERA_ORIENTATION
      );
      cameraDistance = fit.distance;
      framing = fit.framing;
    }
    wallHalfExtent = framedWallExtent(
      aspect,
      cameraDistance,
      framing,
      CAMERA_FOV,
      CAMERA_ORIENTATION
    );
  };

  const bind = () => {
    if (!draws || !assets || !backdrop || !canvasSurface || !studio) return;
    const view = cameraView(
      aspect,
      orbit[0],
      orbit[1],
      cameraDistance,
      CAMERA_FOV,
      CAMERA_ORIENTATION
    );
    const viewProjection = applyProjectionFraming(view.viewProjection, framing);

    draws.wall.set({
      params: lightWallUniforms({ viewProjection, wallHalfExtent }, PYRAMID_SHAPE),
      wallMaterial: assets.wallMaterial,
      wallLighting: assets.wallLighting,
      materialSampler: assets.materialSampler,
    });
    draws.castShadow.set({
      shadow: prismShadowUniforms(viewProjection, PYRAMID_SHADOW),
    });
    draws.caustic.set({
      caustic: {
        viewProjection,
        color: PYRAMID_CAUSTIC.color,
        strength: PYRAMID_CAUSTIC.strength,
        falloff: PYRAMID_CAUSTIC.falloff,
      },
    });

    // vgpu's own glass controls, unchanged: this is its material.
    const glassParams = {
      viewProjection,
      model: PYRAMID_MODEL,
      modelInverse: PYRAMID_MODEL_INVERSE,
      cameraPosition: view.position,
      meshMin: glass!.meshMin,
      meshMax: glass!.meshMax,
      resolution: canvasSurface.size,
      fractalScale: HERO_FRACTAL_GLASS.fractalScale,
      ior: HERO_FRACTAL_GLASS.ior,
      reflectionStrength: HERO_FRACTAL_GLASS.reflectionStrength,
      backOpacity: HERO_FRACTAL_GLASS.backOpacity,
      absorption: HERO_FRACTAL_GLASS.absorption,
      frostRadius: HERO_FRACTAL_GLASS.frostRadius,
      dispersion: HERO_FRACTAL_GLASS.dispersion,
      iridescenceStrength: HERO_FRACTAL_GLASS.iridescenceStrength,
      iridescenceFrequency: HERO_FRACTAL_GLASS.iridescenceFrequency,
      environmentRotation: ENVIRONMENT_ROTATION,
      environmentExposure: HERO_FRACTAL_GLASS.environmentExposure,
      reflectionDebug: 0,
    };
    draws.glassBack.set({
      params: glassParams,
      environmentTexture: studio.view,
      environmentSampler,
    });
    draws.glassFront.set({
      params: glassParams,
      environmentTexture: studio.view,
      environmentSampler,
      sceneTexture: backdrop,
      sceneSampler,
    });
    draws.present.set({ sceneTexture: backdrop });
    interior?.bind({
      viewProjection,
      cameraPosition: view.position,
      environmentRotation: ENVIRONMENT_ROTATION,
      pointer: orbit,
    });
  };

  const render = () => {
    if (!gpu || !canvasSurface || !draws || !backdrop) return;
    const currentGpu = gpu;
    const currentSurface = canvasSurface;
    const currentBackdrop = backdrop;
    const pipeline = draws;
    const currentInterior = interior;
    frame(currentGpu, (current) => {
      // Everything the glass will look through, resolved into one image.
      current.pass(
        {
          target: currentBackdrop,
          clear: [WALL_COLOR_RGB[0], WALL_COLOR_RGB[1], WALL_COLOR_RGB[2], 1],
        },
        (pass) => {
          pass.draw(pipeline.wall);
          pass.draw(pipeline.castShadow);
          pass.draw(pipeline.caustic);
          pass.draw(pipeline.glassBack);
          if (currentInterior) {
            for (const interiorDraw of currentInterior.draws()) pass.draw(interiorDraw);
          }
        }
      );
      current.pass({ target: currentSurface }, (pass) => {
        pass.draw(pipeline.present);
        pass.draw(pipeline.glassFront);
      });
    });
  };

  const tick = (time: number) => {
    animationFrame = 0;
    if (disposed) return;

    orbit = [
      orbit[0] + (pointerTarget[0] - orbit[0]) * CAMERA_ORBIT_LERP,
      orbit[1] + (pointerTarget[1] - orbit[1]) * CAMERA_ORBIT_LERP,
    ];
    interior?.tick(time);
    bind();
    render();

    const settled =
      !interior?.needsFrame() &&
      Math.abs(pointerTarget[0] - orbit[0]) < 0.0005 &&
      Math.abs(pointerTarget[1] - orbit[1]) < 0.0005;
    if (!settled) request();
  };

  const request = () => {
    if (!animationFrame && !disposed && visible && !document.hidden) {
      animationFrame = requestAnimationFrame(tick);
    }
  };

  const resize = () => {
    if (disposed || !canvasSurface) return;
    const rect = options.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvasSurface.resize([
      Math.max(1, Math.round(rect.width * dpr)),
      Math.max(1, Math.round(rect.height * dpr)),
    ]);
    backdrop?.resize(canvasSurface.size);
    aspect = canvasSurface.size[0] / Math.max(1, canvasSurface.size[1]);
    reframe();
    request();
  };

  let releasePointer: (() => void) | undefined;

  const onVisibility = () => {
    if (!document.hidden) request();
  };

  let observer: ResizeObserver | undefined;
  let frameObserver: ResizeObserver | undefined;
  let visibilityObserver: IntersectionObserver | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    abort.abort();
    observer?.disconnect();
    frameObserver?.disconnect();
    visibilityObserver?.disconnect();
    window.removeEventListener("resize", resize);
    releasePointer?.();
    document.removeEventListener("visibilitychange", onVisibility);
    interior?.dispose();
    glass?.dispose();
    studio?.texture.destroy?.();
    assets?.dispose();
    (backdrop as { destroy?: () => void } | undefined)?.destroy?.();
    gpu?.dispose();
  };

  const initialize = async () => {
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    aspect = canvasSurface.size[0] / Math.max(1, canvasSurface.size[1]);

    const [loadedAssets, loadedGlass, loadedStudio] = await Promise.all([
      createPrismAssets(gpu, abort.signal, PYRAMID_SHAPE.grounding),
      loadPyramidGlass(gpu, abort.signal),
      loadStudioCubemap(gpu, abort.signal),
    ]);
    assets = loadedAssets;
    glass = loadedGlass;
    studio = loadedStudio;
    if (disposed) return;

    // One display-space target: the glass reads its own background out of it,
    // and the platform inside needs somewhere to sort itself out against.
    backdrop = target(gpu, {
      size: canvasSurface.size,
      format: canvasSurface.format,
      depth: true,
      label: "prism.hero.backdrop",
    });
    sceneSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    environmentSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
    });
    reframe();

    interior = await createPrismInterior(
      gpu,
      backdrop,
      studio.view,
      environmentSampler,
      abort.signal
    );
    if (disposed) return;

    draws = {
      wall: draw(gpu, {
        shader: wallPresentedWgsl,
        vertices: 6,
        cull: "back",
        depth: false,
        label: "prism.hero.wall",
      }),
      castShadow: draw(gpu, {
        shader: shadowWgsl,
        geometry: pyramidShadowGeometry(gpu, "prism.hero.cast-shadow"),
        blend: "premultiplied",
        cull: "none",
        depth: false,
        label: "prism.hero.cast-shadow",
      }),
      caustic: draw(gpu, {
        shader: heroCausticWgsl,
        geometry: pyramidCausticGeometry(gpu, "prism.hero.caustic"),
        blend: "additive",
        cull: "none",
        depth: false,
        label: "prism.hero.caustic",
      }),
      glassBack: draw(gpu, {
        shader: heroGlassWgsl,
        geometry: glass.geometry,
        cull: "front",
        depth: { write: false },
        blend: "premultiplied",
        label: "prism.hero.glass-back",
      }),
      present: effect(gpu, heroFractalPresentWgsl, { label: "prism.hero.present" }),
      glassFront: draw(gpu, {
        shader: heroGlassTransmissionWgsl,
        geometry: glass.geometry,
        cull: "back",
        depth: false,
        label: "prism.hero.glass-front-transmission",
      }),
    };

    await Promise.all([
      draws.wall.compile(backdrop),
      draws.castShadow.compile(backdrop),
      draws.caustic.compile(backdrop),
      draws.glassBack.compile(backdrop),
      draws.present.compile({ colors: [canvasSurface.format] }),
      draws.glassFront.compile({ colors: [canvasSurface.format] }),
    ]);
    if (disposed) return;

    observer = new ResizeObserver(resize);
    observer.observe(options.canvas);
    visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) request();
    });
    visibilityObserver.observe(options.canvas);
    window.addEventListener("resize", resize);
    releasePointer = followPointer({
      onMove: (position) => {
        pointerTarget = position;
        request();
      },
      // A finger has no hover to lose, so it leaves the view where it put it;
      // this only fires for a mouse crossing the window edge.
      onLeave: () => {
        pointerTarget = [0, 0];
        request();
      },
      read: () => pointerTarget,
    });
    document.addEventListener("visibilitychange", onVisibility);
    if (options.frame) {
      frameObserver = new ResizeObserver(resize);
      frameObserver.observe(options.frame);
    }

    resize();
    request();
  };

  const ready = initialize().catch((error: unknown) => {
    dispose();
    throw error;
  });

  return {
    ready,
    async setState(state: PrismInteriorId) {
      request();
      await interior?.setState(state);
      request();
    },
    resume() {
      if (disposed) return;
      resize();
      request();
    },
    dispose,
  };
}
