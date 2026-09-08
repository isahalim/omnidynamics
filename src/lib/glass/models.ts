import type { Geometry, Gpu } from "vgpu";

import { decodeMesh } from "./hero-glass-assets-core";
import { registerInterior, type HeroFractalScene } from "./scene";
import { withBase } from "../base";

export type PrismState = "orb" | "drone" | "quadruped" | "manipulator" | "robot";

export interface PrismStateInfo {
  readonly id: PrismState;
  readonly label: string;
  /** Where a click on the shape leads, or null while the product is unbuilt. */
  readonly href: string | null;
  /**
   * What the shape in the glass is, for the landing page's copy. Only the
   * shipped tool has anything to say for itself; the rest say what a click on
   * them does, which is all there is to know until they exist.
   */
  readonly blurb?: string;
  /** The line under it, in the smaller size. */
  readonly hint: string;
}

export const PRISM_STATES: readonly PrismStateInfo[] = [
  {
    id: "orb",
    label: "Mythos Engine",
    href: "https://mythosengine.omnidynamics.dev/",
    blurb:
      "A tool that automates content generation and captivates audiences — " +
      "scripts, scenes and voice, from a prompt to a finished piece.",
    hint: "Click the orb to use it",
  },
  { id: "drone", label: "Drone", href: null, hint: "Click the drone for information" },
  {
    id: "quadruped",
    label: "Quadruped",
    href: null,
    hint: "Click the quadruped for information",
  },
  {
    id: "manipulator",
    label: "Manipulator",
    href: null,
    hint: "Click the manipulator for information",
  },
  { id: "robot", label: "Robot", href: null, hint: "Click the robot for information" },
];

/** The orb is vgpu's own fractal geometry held at full sphere morph. */
export const ORB_INTERIOR = "fractal";

export function interiorFor(state: PrismState): string {
  return state === "orb" ? ORB_INTERIOR : state;
}

const inflight = new Map<string, Promise<void>>();

/**
 * Fetches and registers a model interior once. Meshes are a few hundred KB
 * each, so they load on first selection rather than up front.
 */
export function ensureInterior(
  gpu: Gpu,
  scene: HeroFractalScene,
  id: string,
  signal?: AbortSignal
): Promise<void> {
  if (scene.interiors.has(id)) return Promise.resolve();
  let pending = inflight.get(id);
  if (pending) return pending;

  pending = (async () => {
    const url = withBase(`/glass/models/${id}.mesh`);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    signal?.throwIfAborted();
    let mesh: ReturnType<typeof decodeMesh> | undefined;
    try {
      mesh = decodeMesh(gpu, buffer, `interior-${id}`);
      await registerInterior(gpu, scene, id, mesh.geometry, mesh.meshMin, mesh.meshMax);
      (mesh.wireframeGeometry as Geometry & { destroy?: () => void }).destroy?.();
    } catch (error) {
      (mesh?.geometry as Geometry & { destroy?: () => void })?.destroy?.();
      (mesh?.wireframeGeometry as Geometry & { destroy?: () => void })?.destroy?.();
      throw error;
    }
  })();

  inflight.set(id, pending);
  pending.catch(() => inflight.delete(id));
  return pending;
}

/** Warms the two heaviest meshes after first paint so switching feels instant. */
export function prefetchInteriors(): void {
  for (const state of PRISM_STATES) {
    if (state.id === "orb") continue;
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.as = "fetch";
    link.href = withBase(`/glass/models/${state.id}.mesh`);
    link.crossOrigin = "anonymous";
    document.head.append(link);
  }
}
