/**
 * vgpu's light pipeline, wired to a canvas.
 *
 * Six draws build the backdrop — wall, cast shadow, the white beam and the
 * outgoing spectrum, the glass back faces, and the internal spectrum — into an
 * HDR target. The scene pass copies that, refracts it through the front faces
 * and adds the accent layer at 4x MSAA. The presentation pass tone maps to the
 * canvas. The graph is node-for-node the one vgpu.sh/?debug draws.
 */
import type { Draw, Effect, Gpu, Surface, Target } from "vgpu";
import { draw, effect, frame, surface, target, init } from "vgpu";

import causticWgsl from "./caustic.wgsl";
import copyLinearWgsl from "./copy-linear.wgsl";
import glassAccentWgsl from "./glass-accent.wgsl";
import glassBackWgsl from "./glass-back.wgsl";
import glassWgsl from "./glass.wgsl";
import presentWgsl from "./present.wgsl";
import shadowWgsl from "./shadow.wgsl";
import wallWgsl from "./wall.wgsl";

import { createPrismAssets, type PrismAssets } from "./assets";
import { cameraView } from "./camera";
import {
  CAMERA_DISTANCE,
  CAMERA_FOV_DEGREES,
  CAMERA_ORBIT_LERP,
  PRISM_BEAM_MOUSE_Y,
  PRISM_BEAM_WIDTH,
  PRISM_DEFAULT_ARC,
  PRISM_GLASS_ACCENT,
  PRISM_LIGHT_FADE,
  PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES,
  PRISM_SPECTRAL_DISPERSION,
  type Vec2,
} from "./constants";
import { prismGeometry, prismShadowGeometry } from "./geometry";
import {
  IDENTITY_FRAMING,
  applyProjectionFraming,
  fitFraming,
  framedWallExtent,
  viewportWithinCanvas,
  type ProjectionFraming,
} from "./framing";
import {
  HIGH_LIGHT_MESH_LAYOUT,
  LIGHT_VERTEX_FLOATS,
  LIGHT_VERTEX_STRIDE,
  buildLightMesh,
  lampForIncidence,
  type CollimatedLight,
} from "./light-mesh";
import {
  glassUniforms,
  lightCausticUniforms,
  lightPresentUniforms,
  lightWallUniforms,
  prismShadowUniforms,
  sceneUniforms,
  type FrameState,
} from "./uniforms";

/** vgpu's own reveal: opacity over a second, the beam opening over ~2.5. */
const BEAM_REVEAL_DELAY = 1 - Math.cbrt(0.75);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const revealAt = (seconds: number) => ({
  opacity: 1 - (1 - clamp01(seconds)) ** 3,
  beamWidth: 1 - (1 - clamp01((seconds - BEAM_REVEAL_DELAY) / (2.5 - BEAM_REVEAL_DELAY))) ** 3,
});

export interface PrismRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /**
   * Element whose box the prism is fitted into. The canvas still covers the
   * whole viewport — this only says where in it the glass belongs, so a page
   * can seat the shape beside its copy without the wall breaking into columns.
   * Omit to keep the prism centred, as vgpu's own hero does.
   */
  readonly frame?: HTMLElement;
}

export interface PrismRenderer {
  readonly ready: Promise<void>;
  dispose(): void;
}

/** The angle of incidence the lamp arc maps to, as vgpu swings it. */
function incidenceAt(arc: number): number {
  const t = clamp01(arc);
  const midpoint = PRISM_MOUSE_Y_MIDPOINT_INCIDENCE_DEGREES;
  return t <= 0.5
    ? PRISM_BEAM_MOUSE_Y.top + (midpoint - PRISM_BEAM_MOUSE_Y.top) * t * 2
    : midpoint + (PRISM_BEAM_MOUSE_Y.bottom - midpoint) * (t - 0.5) * 2;
}

const lampAt = (arc: number): CollimatedLight =>
  lampForIncidence(incidenceAt(arc), PRISM_BEAM_WIDTH, 0.5);

export function createPrismRenderer(options: PrismRendererOptions): PrismRenderer {
  const layout = HIGH_LIGHT_MESH_LAYOUT;
  const abort = new AbortController();
  let disposed = false;

  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let assets: PrismAssets | undefined;
  let backdrop: Target | undefined;
  let scene: Target | undefined;
  let lightBuffer: ReturnType<Gpu["device"]["createBuffer"]> | undefined;
  let draws:
    | {
        wall: Draw;
        prismShadow: Draw;
        caustic: Draw;
        glassBack: Draw;
        copyBackdrop: Effect;
        glassFront: Draw;
        glassAccent: Draw;
        present: Effect;
      }
    | undefined;

  const lightVertices = new Float32Array(layout.vertexCount * LIGHT_VERTEX_FLOATS);
  const lightScratch: number[] = [];

  let aspect = 1;
  let cameraDistance = CAMERA_DISTANCE;
  let framing: ProjectionFraming = IDENTITY_FRAMING;
  let orbit: Vec2 = [0, 0];
  let pointerTarget: Vec2 = [0, 0];
  let lampArc = PRISM_DEFAULT_ARC;
  let lampArcTarget = PRISM_DEFAULT_ARC;
  let light = lampAt(lampArc);
  let wallHalfExtent: Vec2 = [1, 1];
  let lightExtent: Vec2 = [1, 1];

  let startTime = 0;
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
      cameraDistance = CAMERA_DISTANCE;
      framing = IDENTITY_FRAMING;
    } else {
      const fit = fitFraming(aspect, viewport);
      cameraDistance = fit.distance;
      framing = fit.framing;
    }
    wallHalfExtent = framedWallExtent(aspect, cameraDistance, framing);
    // Portrait canvases need a wider sweep so the fan still reaches the edge.
    const widen = Math.min(2.5, Math.max(1, 1 / Math.max(aspect, 0.001)));
    lightExtent = [wallHalfExtent[0] * widen, wallHalfExtent[1] * widen];
    rebuildLight();
  };

  const rebuildLight = () => {
    light = lampAt(lampArc);
    buildLightMesh(
      {
        light,
        dispersion: PRISM_SPECTRAL_DISPERSION,
        edgeFalloff: PRISM_LIGHT_FADE.edgeFalloff,
        wallHalfExtent: lightExtent,
        samples: layout.samples,
        beamSlices: layout.beamSlices,
      },
      lightVertices,
      lightScratch
    );
    lightBuffer?.write(lightVertices);
  };

  const frameState = (revealProgress: number, beamWidthReveal: number): FrameState => {
    const view = cameraView(aspect, orbit[0], orbit[1], cameraDistance, CAMERA_FOV_DEGREES);
    return {
      viewProjection: applyProjectionFraming(view.viewProjection, framing),
      cameraPosition: view.position,
      wallHalfExtent,
      beamDirection: light.direction,
      layout,
      revealProgress,
      beamWidthReveal,
    };
  };

  const bind = (state: FrameState) => {
    if (!draws || !assets || !backdrop || !scene) return;
    const glass = glassUniforms(state);
    draws.wall.set({
      params: lightWallUniforms(state),
      wallMaterial: assets.wallMaterial,
      wallLighting: assets.wallLighting,
      materialSampler: assets.materialSampler,
    });
    draws.prismShadow.set({ shadow: prismShadowUniforms(state.viewProjection) });
    draws.caustic.set({
      scene: sceneUniforms(state),
      caustic: lightCausticUniforms(),
      causticProfile: assets.causticProfile,
      causticSampler: assets.materialSampler,
      wallMaterial: assets.wallMaterial,
    });
    draws.glassBack.set({
      params: glass,
      studioEnvironment: assets.studioEnvironment,
      environmentSampler: assets.environmentSampler,
    });
    draws.copyBackdrop.set({ sceneTexture: backdrop });
    draws.glassFront.set({
      params: glass,
      sceneTexture: backdrop,
      sceneSampler: assets.sceneSampler,
      studioEnvironment: assets.studioEnvironment,
      environmentSampler: assets.environmentSampler,
    });
    draws.glassAccent.set({
      params: glass,
      accent: { ...PRISM_GLASS_ACCENT },
      studioEnvironment: assets.studioEnvironment,
      environmentSampler: assets.environmentSampler,
    });
    draws.present.set({
      sceneTexture: scene,
      params: lightPresentUniforms(state.revealProgress),
    });
  };

  const render = () => {
    if (!gpu || !canvasSurface || !draws || !backdrop || !scene) return;
    const currentGpu = gpu;
    const currentSurface = canvasSurface;
    const currentBackdrop = backdrop;
    const currentScene = scene;
    const pipeline = draws;
    frame(currentGpu, (current) => {
      current.pass({ target: currentBackdrop, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(pipeline.wall);
        pass.draw(pipeline.prismShadow);
        pass.draw(pipeline.caustic, { firstVertex: 0, vertices: layout.whiteVertices });
        pass.draw(pipeline.caustic, {
          firstVertex: layout.outgoingFirstVertex,
          vertices: layout.outgoingVertices,
        });
        pass.draw(pipeline.glassBack);
        pass.draw(pipeline.caustic, {
          firstVertex: layout.internalFirstVertex,
          vertices: layout.internalVertices,
        });
      });
      current.pass({ target: currentScene, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(pipeline.copyBackdrop);
        pass.draw(pipeline.glassFront);
        pass.draw(pipeline.glassAccent);
      });
      current.pass({ target: currentSurface }, (pass) => pass.draw(pipeline.present));
    });
  };

  const tick = (time: number) => {
    animationFrame = 0;
    if (disposed) return;
    if (!startTime) startTime = time;
    const elapsed = (time - startTime) * 0.001;
    const reveal = revealAt(elapsed);

    orbit = [
      orbit[0] + (pointerTarget[0] - orbit[0]) * CAMERA_ORBIT_LERP,
      orbit[1] + (pointerTarget[1] - orbit[1]) * CAMERA_ORBIT_LERP,
    ];
    if (Math.abs(lampArcTarget - lampArc) > 0.0002) {
      lampArc += (lampArcTarget - lampArc) * 0.12;
      rebuildLight();
    }

    const state = frameState(reveal.opacity, reveal.beamWidth);
    bind(state);
    render();

    const settled =
      reveal.beamWidth >= 1 &&
      Math.abs(pointerTarget[0] - orbit[0]) < 0.0005 &&
      Math.abs(pointerTarget[1] - orbit[1]) < 0.0005 &&
      Math.abs(lampArcTarget - lampArc) <= 0.0002;
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
    const size: [number, number] = [
      Math.max(1, Math.round(rect.width * dpr)),
      Math.max(1, Math.round(rect.height * dpr)),
    ];
    canvasSurface.resize(size);
    backdrop?.resize(canvasSurface.size);
    scene?.resize(canvasSurface.size);
    aspect = canvasSurface.size[0] / Math.max(1, canvasSurface.size[1]);
    reframe();
    request();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    pointerTarget = [
      Math.min(1, Math.max(-1, (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1)),
      Math.min(1, Math.max(-1, (event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1)),
    ];
    lampArcTarget = clamp01(event.clientY / Math.max(window.innerHeight, 1));
    request();
  };

  const resetPointer = () => {
    pointerTarget = [0, 0];
    lampArcTarget = PRISM_DEFAULT_ARC;
    request();
  };

  const onPointerOut = (event: PointerEvent) => {
    if (event.relatedTarget === null) resetPointer();
  };

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
    visibilityObserver?.disconnect();
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerout", onPointerOut);
    window.removeEventListener("blur", resetPointer);
    document.removeEventListener("visibilitychange", onVisibility);
    frameObserver?.disconnect();
    assets?.dispose();
    (backdrop as { destroy?: () => void } | undefined)?.destroy?.();
    (scene as { destroy?: () => void } | undefined)?.destroy?.();
    lightBuffer?.destroy?.();
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

    assets = await createPrismAssets(gpu, abort.signal);
    if (disposed) return;

    backdrop = target(gpu, {
      size: canvasSurface.size,
      format: "rgba16float",
      label: "prism.light.backdrop-hdr",
    });
    scene = target(gpu, {
      size: canvasSurface.size,
      format: "rgba16float",
      // vgpu resolves the scene at 4x; compatibility mode has no MSAA to give.
      msaa: gpu.device.isCompatibilityMode ? undefined : 4,
      label: "prism.light.scene-hdr",
    });

    lightBuffer = gpu.device.createBuffer({
      size: layout.vertexCount * LIGHT_VERTEX_STRIDE,
      usage: ["vertex", "copy_dst"],
      label: "prism.light.light-vertices",
    });
    reframe();

    const prism = prismGeometry(gpu, "prism.light.prism");
    const shadowGeometry = prismShadowGeometry(gpu, "prism.light.prism-shadow");
    const lightGeometry = {
      vertexBuffers: [lightBuffer.gpu],
      vertexBufferLayouts: [
        {
          arrayStride: LIGHT_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" as GPUVertexFormat },
            { shaderLocation: 3, offset: 8, format: "float32" as GPUVertexFormat },
          ],
        },
      ],
      vertexCount: layout.vertexCount,
    };

    draws = {
      wall: draw(gpu, {
        shader: wallWgsl,
        vertices: 6,
        cull: "back",
        depth: false,
        label: "prism.light.wall",
      }),
      prismShadow: draw(gpu, {
        shader: shadowWgsl,
        geometry: shadowGeometry,
        blend: "premultiplied",
        cull: "none",
        depth: false,
        label: "prism.light.prism-cast-shadow",
      }),
      caustic: draw(gpu, {
        shader: causticWgsl,
        geometry: lightGeometry,
        blend: "additive",
        cull: "none",
        depth: false,
        label: "prism.light.projected-caustic",
      }),
      glassBack: draw(gpu, {
        shader: glassBackWgsl,
        geometry: prism,
        cull: "front",
        depth: false,
        blend: "premultiplied",
        label: "prism.light.glass-back",
      }),
      copyBackdrop: effect(gpu, copyLinearWgsl, { label: "prism.light.copy-backdrop" }),
      glassFront: draw(gpu, {
        shader: glassWgsl,
        geometry: prism,
        cull: "back",
        depth: false,
        label: "prism.light.glass-front",
      }),
      glassAccent: draw(gpu, {
        shader: glassAccentWgsl,
        geometry: prism,
        cull: "back",
        depth: false,
        blend: "premultiplied",
        label: "prism.light.glass-accent",
      }),
      present: effect(gpu, presentWgsl, { label: "prism.light.present" }),
    };

    await Promise.all([
      draws.wall.compile(backdrop),
      draws.prismShadow.compile(backdrop),
      draws.caustic.compile(backdrop),
      draws.glassBack.compile(backdrop),
      draws.copyBackdrop.compile(scene),
      draws.glassFront.compile(scene),
      draws.glassAccent.compile(scene),
      draws.present.compile({ colors: [canvasSurface.format] }),
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
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut);
    window.addEventListener("blur", resetPointer);
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

  return { ready, dispose };
}
