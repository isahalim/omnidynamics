/**
 * Everything the light pipeline samples, baked on the GPU at start-up exactly as
 * vgpu bakes it:
 *
 *   wall material   512x512   albedo / tangent-normal XY / roughness
 *   wall lighting   512x512   R the authored window mask, GB the prism's contact
 *                             shadow and ambient occlusion
 *   caustic profile 1024x256  distance x wavelength, the filaments in the fan
 *   studio          1024x512  equirectangular HDR with a prefiltered mip pyramid
 *
 * The only file fetched is vgpu's own `wall-global-light-mask.webp`; if it cannot
 * be read the bake falls back to the procedural window pools vgpu ships for the
 * same purpose, so the wall is never flat.
 */
import type { Gpu } from "vgpu";
import { effect, frame, sampler, target } from "vgpu";
import type { Texture } from "vgpu/core";
import { createSampler } from "vgpu/core";

import bakeCausticProfileWgsl from "./bake-caustic-profile.wgsl";
import bakeDownsampleWgsl from "./bake-downsample.wgsl";
import bakeWallLightingWgsl from "./bake-wall-lighting.wgsl";
import bakeWallMaterialWgsl from "./bake-wall-material.wgsl";
import environmentBakeWgsl from "./environment-bake.wgsl";
import environmentBlurWgsl from "./environment-blur.wgsl";
import {
  CAUSTIC_PROFILE_SIZE,
  ENVIRONMENT_MIP_LEVELS,
  ENVIRONMENT_SIZE,
  WALL_LIGHTING_SIZE,
  WALL_LIGHT_MASK_URL,
  WALL_MATERIAL_SIZE,
  type Vec2,
} from "./constants";

export interface PrismAssets {
  readonly wallMaterial: Texture;
  readonly wallLighting: Texture;
  readonly causticProfile: Texture;
  readonly studioEnvironment: Texture;
  readonly environmentSampler: GPUSampler;
  readonly materialSampler: GPUSampler;
  readonly sceneSampler: GPUSampler;
  dispose(): void;
}

const mipLevelsFor = (size: Vec2) => Math.floor(Math.log2(Math.max(size[0], size[1]))) + 1;

/** vgpu's authored mask, or nothing when it is unavailable. */
async function loadWallMask(gpu: Gpu, signal?: AbortSignal): Promise<Texture | undefined> {
  try {
    const response = await fetch(WALL_LIGHT_MASK_URL, { signal });
    if (!response.ok) return undefined;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const texture = gpu.device.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage: ["texture_binding", "copy_dst", "render_attachment"],
        label: "prism.light.wall-global-light-mask",
      });
      gpu.gpu.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: texture.gpu },
        [bitmap.width, bitmap.height]
      );
      return texture;
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    return undefined;
  }
}

/**
 * Renders one generator into level zero of a mipped texture, then box-filters
 * the rest of the chain out of it.
 *
 * vgpu bakes these with compute and storage textures; this build of vgpu binds
 * only sampled textures, so each level is a fullscreen pass copied into place —
 * same maths, same mip chain.
 */
async function bakeMipped(
  gpu: Gpu,
  size: Vec2,
  label: string,
  source: string,
  bindings: Record<string, unknown>
): Promise<Texture> {
  const mipLevelCount = mipLevelsFor(size);
  const texture = gpu.device.createTexture({
    size: [size[0], size[1]],
    format: "rgba8unorm",
    mipLevelCount,
    usage: ["texture_binding", "copy_dst"],
    label: `prism.light.${label}`,
  });
  const scratch = target(gpu, {
    size: [size[0], size[1]],
    format: "rgba8unorm",
    label: `prism.light.${label}.level0`,
  });
  try {
    const bake = effect(gpu, source, { label: `prism.light.${label}-bake` });
    bake.set(bindings);
    await bake.compile(scratch);
    frame(gpu, (current) => {
      current.pass({ target: scratch, clear: [0, 0, 0, 1] }, (pass) => pass.draw(bake));
    });
    copyLevel(gpu, scratch, texture, 0);

    const downsample = effect(gpu, bakeDownsampleWgsl, {
      label: `prism.light.${label}-downsample`,
    });
    let compiled = false;
    for (let level = 1; level < mipLevelCount; level++) {
      const levelSize: Vec2 = [
        Math.max(1, size[0] >> level),
        Math.max(1, size[1] >> level),
      ];
      const next = target(gpu, {
        size: [levelSize[0], levelSize[1]],
        format: "rgba8unorm",
        label: `prism.light.${label}.level${level}`,
      });
      try {
        downsample.set({
          sourceTexture: texture.gpu.createView({
            baseMipLevel: level - 1,
            mipLevelCount: 1,
          }),
        });
        if (!compiled) {
          await downsample.compile(next);
          compiled = true;
        }
        frame(gpu, (current) => {
          current.pass({ target: next }, (pass) => pass.draw(downsample));
        });
        copyLevel(gpu, next, texture, level);
      } finally {
        destroyTarget(next);
      }
    }
    return texture;
  } catch (error) {
    texture.destroy?.();
    throw error;
  } finally {
    destroyTarget(scratch);
  }
}

export async function createPrismAssets(gpu: Gpu, signal?: AbortSignal): Promise<PrismAssets> {
  const mask = await loadWallMask(gpu, signal);
  signal?.throwIfAborted();

  const maskSampler = createSampler(gpu.device, {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
    label: "prism.light.wall-mask-sampler",
  });
  // The lighting bake always binds a mask texture; a 1x1 stands in when the
  // authored one is missing and `useMask` switches the shader to its fallback.
  const placeholder =
    mask ??
    gpu.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: ["texture_binding", "copy_dst"],
      label: "prism.light.wall-mask-placeholder",
    });

  const baked: Texture[] = [];
  try {
    const wallMaterial = await bakeMipped(
      gpu,
      WALL_MATERIAL_SIZE,
      "wall-material",
      bakeWallMaterialWgsl,
      { params: { size: WALL_MATERIAL_SIZE } }
    );
    baked.push(wallMaterial);
    const wallLighting = await bakeMipped(
      gpu,
      WALL_LIGHTING_SIZE,
      "wall-lighting",
      bakeWallLightingWgsl,
      {
        params: { useMask: mask ? 1 : 0 },
        wallMask: placeholder,
        wallMaskSampler: maskSampler,
      }
    );
    baked.push(wallLighting);
    const causticProfile = await bakeMipped(
      gpu,
      CAUSTIC_PROFILE_SIZE,
      "caustic-profile",
      bakeCausticProfileWgsl,
      { params: { size: CAUSTIC_PROFILE_SIZE } }
    );
    baked.push(causticProfile);
    signal?.throwIfAborted();

    const environmentSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
    });
    const studioEnvironment = await bakeEnvironment(gpu, environmentSampler);

    const materialSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    const sceneSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    placeholder.destroy?.();
    let disposed = false;
    return {
      wallMaterial,
      wallLighting,
      causticProfile,
      studioEnvironment,
      environmentSampler,
      materialSampler,
      sceneSampler,
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const texture of [...baked, studioEnvironment]) texture.destroy?.();
      },
    };
  } catch (error) {
    for (const texture of baked) texture.destroy?.();
    placeholder.destroy?.();
    throw error;
  }
}

/**
 * Rasterises the analytic studio into an equirectangular HDR texture, then walks
 * a separable blur down the mip chain so a rough reflection can pick the level
 * matching its footprint.
 */
async function bakeEnvironment(gpu: Gpu, environmentSampler: GPUSampler): Promise<Texture> {
  const texture = gpu.device.createTexture({
    size: [ENVIRONMENT_SIZE[0], ENVIRONMENT_SIZE[1]],
    format: "rgba16float",
    mipLevelCount: ENVIRONMENT_MIP_LEVELS,
    usage: ["texture_binding", "copy_dst"],
    label: "prism.light.environment-studio",
  });
  const bake = effect(gpu, environmentBakeWgsl, { label: "prism.light.environment-bake" });
  const blur = effect(gpu, environmentBlurWgsl, { label: "prism.light.environment-blur" });

  let level = target(gpu, {
    size: [ENVIRONMENT_SIZE[0], ENVIRONMENT_SIZE[1]],
    format: "rgba16float",
    label: "prism.light.environment.level0",
  });
  try {
    await Promise.all([bake.compile(level), blur.compile(level)]);
    frame(gpu, (current) => {
      current.pass({ target: level, clear: [0, 0, 0, 1] }, (pass) => pass.draw(bake));
    });
    copyLevel(gpu, level, texture, 0);

    for (let mip = 1; mip < ENVIRONMENT_MIP_LEVELS; mip++) {
      const size: Vec2 = [
        Math.max(1, ENVIRONMENT_SIZE[0] >> mip),
        Math.max(1, ENVIRONMENT_SIZE[1] >> mip),
      ];
      const horizontal = target(gpu, {
        size,
        format: "rgba16float",
        label: `prism.light.environment.blur-h${mip}`,
      });
      const next = target(gpu, {
        size,
        format: "rgba16float",
        label: `prism.light.environment.level${mip}`,
      });
      const texel: Vec2 = [1 / size[0], 1 / size[1]];
      blur.set({
        src: level,
        src_samp: environmentSampler,
        blur: { texel, direction: [1, 0], radius: 1.15, equirect_compensation: 1 },
      });
      frame(gpu, (current) => {
        current.pass({ target: horizontal }, (pass) => pass.draw(blur));
      });
      blur.set({
        src: horizontal,
        src_samp: environmentSampler,
        blur: { texel, direction: [0, 1], radius: 1.15, equirect_compensation: 0 },
      });
      frame(gpu, (current) => {
        current.pass({ target: next }, (pass) => pass.draw(blur));
      });
      copyLevel(gpu, next, texture, mip);
      destroyTarget(horizontal);
      destroyTarget(level);
      level = next;
    }
    destroyTarget(level);
    return texture;
  } catch (error) {
    destroyTarget(level);
    texture.destroy?.();
    throw error;
  }
}

function copyLevel(
  gpu: Gpu,
  source: ReturnType<typeof target>,
  destination: Texture,
  mipLevel: number
): void {
  const encoder = gpu.gpu.createCommandEncoder({
    label: `${destination.label}.copy-level${mipLevel}`,
  });
  encoder.copyTextureToTexture(
    { texture: source.color.gpu },
    { texture: destination.gpu, mipLevel },
    [source.size[0], source.size[1], 1]
  );
  gpu.gpu.queue.submit([encoder.finish()]);
}

function destroyTarget(value: { destroy?: () => void }): void {
  value.destroy?.();
}
