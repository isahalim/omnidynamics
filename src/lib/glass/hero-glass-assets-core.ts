import type { Geometry, GeometryBufferOptions, Gpu } from "vgpu";
import { geometry } from "vgpu";
import type { Texture } from "vgpu/core";
import { createSampler, cubeView } from "vgpu/core";

import { prismMeshData } from "../prism/geometry";

/**
 * Scales vgpu's cross-section to the world the landing camera frames: the same
 * height the old tetrahedron had, so the camera, the shadow footprint and the
 * interior fitting all keep their tuning.
 */
const GLASS_PRISM_SCALE = 2.666;
/** Stands it on y = -0.333 and centres the extrusion on z = 0. */
const GLASS_PRISM_OFFSET = [0, 0.10565, -0.43989] as const;

const MESH_HEADER_SIZE = 40;
const CUBEMAP_COLUMNS = 3;
const CUBEMAP_ROWS = 2;

export interface HeroGlassAssets {
  readonly geometry: Geometry;
  readonly wireframeGeometry: Geometry;
  readonly meshMin: readonly [number, number, number];
  readonly meshMax: readonly [number, number, number];
  readonly fractalGeometry: Geometry;
  readonly fractalWireframeGeometry: Geometry;
  readonly fractalMeshMin: readonly [number, number, number];
  readonly fractalMeshMax: readonly [number, number, number];
  readonly environment: Texture;
  readonly environmentView: GPUTextureView;
  readonly wallMaterial: Texture;
  readonly wallSampler: GPUSampler;
  dispose(): void;
}

export interface RgbaAtlas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Environment-neutral mesh decoding and cubemap upload used by browser and Node. */
export function createHeroGlassAssets(
  gpu: Gpu,
  fractalMeshBuffer: ArrayBuffer,
  atlas: RgbaAtlas,
  wallAtlas: RgbaAtlas
): HeroGlassAssets {
  const glassMesh = createGlassPrismGeometry(gpu);
  let fractalMesh: ReturnType<typeof decodeMesh> | undefined;
  let environment: Texture | undefined;
  try {
    fractalMesh = decodeMesh(gpu, fractalMeshBuffer, "fractal-pyramid-face-l7");
    const faceSize = atlas.height / CUBEMAP_ROWS;
    const mipLevelCount = Math.floor(Math.log2(faceSize)) + 1;
    let expectedWidth = 0;
    for (let level = 0; level < mipLevelCount; level++)
      expectedWidth += CUBEMAP_COLUMNS * Math.max(1, faceSize >> level);
    if (
      !Number.isInteger(faceSize) ||
      2 ** (mipLevelCount - 1) !== faceSize ||
      atlas.width !== expectedWidth ||
      atlas.data.byteLength !== atlas.width * atlas.height * 4
    ) {
      throw new Error(
        "Hero cubemap atlas must contain a packed spherical mip chain."
      );
    }
    environment = gpu.device.createTexture({
      size: [faceSize, faceSize, 6],
      format: "rgba8unorm-srgb",
      usage: ["texture_binding", "copy_dst"],
      mipLevelCount,
      label: "homepage-light-glass-studio-cubemap",
    });
    uploadPackedCubemapMipAtlas(
      gpu,
      environment,
      atlas,
      faceSize,
      mipLevelCount
    );
    const loadedEnvironment = environment;
    const loadedFractal = fractalMesh;
    const environmentView = cubeView(loadedEnvironment, {
      compat: true,
      label: "homepage-light-glass-studio-cubemap-array-view",
    });
    const wall = createWallMaterial(gpu, wallAtlas);
    let disposed = false;
    return {
      ...glassMesh,
      wallMaterial: wall.texture,
      wallSampler: wall.sampler,
      fractalGeometry: loadedFractal.geometry,
      fractalWireframeGeometry: loadedFractal.wireframeGeometry,
      fractalMeshMin: loadedFractal.meshMin,
      fractalMeshMax: loadedFractal.meshMax,
      environment: loadedEnvironment,
      environmentView,
      dispose() {
        if (disposed) return;
        disposed = true;
        destroyAll([
          glassMesh.geometry,
          glassMesh.wireframeGeometry,
          loadedFractal.geometry,
          loadedFractal.wireframeGeometry,
          loadedEnvironment,
          wall.texture,
        ]);
      },
    };
  } catch (error) {
    try {
      destroyAll([
        glassMesh.geometry,
        glassMesh.wireframeGeometry,
        fractalMesh?.geometry,
        fractalMesh?.wireframeGeometry,
        environment,
      ]);
    } catch {
      // Preserve the construction failure after attempting every rollback.
    }
    throw error;
  }
}

/**
 * The prefiltered studio, as a cubemap with its mip chain.
 *
 * The atlas packs six faces per level across three columns, each level laid out
 * to the right of the last. This is the environment vgpu's glass-fractal
 * material reflects and its interior is lit by, so both pages that show that
 * material read the same texture.
 */
export function createStudioCubemap(gpu: Gpu, atlas: RgbaAtlas) {
  const faceSize = atlas.height / CUBEMAP_ROWS;
  const mipLevelCount = Math.floor(Math.log2(faceSize)) + 1;
  let expectedWidth = 0;
  for (let level = 0; level < mipLevelCount; level++)
    expectedWidth += CUBEMAP_COLUMNS * Math.max(1, faceSize >> level);
  if (
    !Number.isInteger(faceSize) ||
    2 ** (mipLevelCount - 1) !== faceSize ||
    atlas.width !== expectedWidth ||
    atlas.data.byteLength !== atlas.width * atlas.height * 4
  ) {
    throw new Error("Hero cubemap atlas must contain a packed spherical mip chain.");
  }
  const texture = gpu.device.createTexture({
    size: [faceSize, faceSize, 6],
    format: "rgba8unorm-srgb",
    usage: ["texture_binding", "copy_dst"],
    mipLevelCount,
    label: "homepage-light-glass-studio-cubemap",
  });
  uploadPackedCubemapMipAtlas(gpu, texture, atlas, faceSize, mipLevelCount);
  return {
    texture,
    view: cubeView(texture, {
      compat: true,
      label: "homepage-light-glass-studio-cubemap-array-view",
    }),
  };
}

/**
 * Uploads the baked plaster material with a box-filtered mip chain. Without
 * mips the normal field aliases badly where the floor recedes.
 */
function createWallMaterial(gpu: Gpu, atlas: RgbaAtlas) {
  const size = atlas.width;
  if (atlas.height !== size || (size & (size - 1)) !== 0)
    throw new Error("Wall material must be a square power-of-two texture.");
  const mipLevelCount = Math.log2(size) + 1;
  const texture = gpu.device.createTexture({
    size: [size, size, 1],
    format: "rgba8unorm",
    usage: ["texture_binding", "copy_dst"],
    mipLevelCount,
    label: "wall-plaster-material",
  });

  let level = new Uint8Array(atlas.data);
  let levelSize = size;
  for (let mipLevel = 0; mipLevel < mipLevelCount; mipLevel++) {
    const bytesPerRow = Math.ceil(levelSize * 4 / 256) * 256;
    const upload = new Uint8Array(bytesPerRow * levelSize);
    for (let row = 0; row < levelSize; row++)
      upload.set(level.subarray(row * levelSize * 4, (row + 1) * levelSize * 4), row * bytesPerRow);
    gpu.gpu.queue.writeTexture(
      { texture: texture.gpu, mipLevel },
      upload,
      { bytesPerRow, rowsPerImage: levelSize },
      [levelSize, levelSize, 1]
    );
    if (mipLevel + 1 >= mipLevelCount) break;
    level = downsample(level, levelSize);
    levelSize >>= 1;
  }

  // vgpu exposes samplers as a free helper on `vgpu/core`; the device wrapper
  // has no `createSampler`.
  const sampler = createSampler(gpu.device, {
    minFilter: "linear",
    magFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "repeat",
    maxAnisotropy: 8,
    label: "wall-plaster-sampler",
  });
  return { texture, sampler };
}

function downsample(source: Uint8Array, size: number): Uint8Array {
  const half = size >> 1;
  const out = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++)
    for (let x = 0; x < half; x++)
      for (let c = 0; c < 4; c++) {
        const a = source[((y * 2) * size + x * 2) * 4 + c]!;
        const b = source[((y * 2) * size + x * 2 + 1) * 4 + c]!;
        const d = source[((y * 2 + 1) * size + x * 2) * 4 + c]!;
        const e = source[((y * 2 + 1) * size + x * 2 + 1) * 4 + c]!;
        out[(y * half + x) * 4 + c] = (a + b + d + e + 2) >> 2;
      }
  return out;
}

function uploadPackedCubemapMipAtlas(
  gpu: Gpu,
  environment: Texture,
  atlas: RgbaAtlas,
  faceSize: number,
  mipLevelCount: number
): void {
  let levelOffsetX = 0;
  for (let mipLevel = 0; mipLevel < mipLevelCount; mipLevel++) {
    const mipSize = Math.max(1, faceSize >> mipLevel);
    for (let face = 0; face < 6; face++) {
      const tileX = levelOffsetX + (face % CUBEMAP_COLUMNS) * mipSize;
      const tileY = Math.floor(face / CUBEMAP_COLUMNS) * mipSize;
      uploadCubemapMip(
        gpu,
        environment,
        atlas,
        tileX,
        tileY,
        face,
        mipLevel,
        mipSize
      );
    }
    levelOffsetX += CUBEMAP_COLUMNS * mipSize;
  }
}

function uploadCubemapMip(
  gpu: Gpu,
  environment: Texture,
  atlas: RgbaAtlas,
  tileX: number,
  tileY: number,
  face: number,
  mipLevel: number,
  size: number
): void {
  const sourceBytesPerRow = size * 4;
  const bytesPerRow = Math.ceil(sourceBytesPerRow / 256) * 256;
  const upload = new Uint8Array(bytesPerRow * size);
  for (let row = 0; row < size; row++) {
    const sourceStart = ((tileY + row) * atlas.width + tileX) * 4;
    upload.set(
      atlas.data.subarray(sourceStart, sourceStart + sourceBytesPerRow),
      row * bytesPerRow
    );
  }
  gpu.gpu.queue.writeTexture(
    { texture: environment.gpu, mipLevel, origin: [0, 0, face] },
    upload,
    { bytesPerRow, rowsPerImage: size },
    [size, size, 1]
  );
}

/** Decodes an HGP1/HGP2 mesh payload into GPU geometry plus its bounds. */
export function decodeMesh(gpu: Gpu, buffer: ArrayBuffer, label: string) {
  if (buffer.byteLength < MESH_HEADER_SIZE)
    throw new Error("Hero glass mesh header is truncated.");
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  const hasSphereTarget = magic === "HGP2";
  if (magic !== "HGP1" && !hasSphereTarget)
    throw new Error("Unsupported hero glass mesh format.");
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const vertexStride = view.getUint32(12, true);
  const expectedStride = hasSphereTarget ? 24 : 16;
  if (vertexStride !== expectedStride || vertexCount <= 0 || indexCount <= 0)
    throw new Error("Hero glass mesh layout is invalid.");
  const meshMin = [
    view.getFloat32(16, true),
    view.getFloat32(20, true),
    view.getFloat32(24, true),
  ] as const;
  const meshMax = [
    view.getFloat32(28, true),
    view.getFloat32(32, true),
    view.getFloat32(36, true),
  ] as const;
  const vertexByteLength = vertexCount * vertexStride;
  const indexOffset = MESH_HEADER_SIZE + vertexByteLength;
  const expectedLength = indexOffset + indexCount * 2;
  if (expectedLength !== buffer.byteLength)
    throw new Error("Hero glass mesh payload length is invalid.");
  const vertexData = new Uint8Array(
    buffer.slice(MESH_HEADER_SIZE, indexOffset)
  );
  const indices = padTriangleIndices(new Uint16Array(buffer.slice(indexOffset)));
  // A line list always has an even index count, so its uint16 buffer is
  // already 4-byte aligned and needs no padding.
  const wireframeIndices = triangleEdges(indices);
  const buffers: GeometryBufferOptions[] = [
    {
      data: vertexData,
      stride: vertexStride,
      attributes: hasSphereTarget
        ? {
            packed_position: "unorm16x4",
            packed_normal: "snorm16x4",
            packed_sphere: "snorm16x4",
          }
        : { packed_position: "unorm16x4", packed_normal: "snorm16x4" },
    },
  ];
  let solid: Geometry | undefined;
  try {
    solid = geometry(gpu, {
      label: `homepage-light-${label}`,
      buffers,
      indices,
    });
    return {
      geometry: solid,
      wireframeGeometry: geometry(gpu, {
        label: `homepage-light-${label}-wireframe`,
        topology: "line-list",
        buffers,
        indices: wireframeIndices,
      }),
      meshMin,
      meshMax,
    };
  } catch (error) {
    try {
      solid?.destroy();
    } catch {
      // Preserve the geometry construction failure.
    }
    throw error;
  }
}

/**
 * Pads a triangle list until its uint16 buffer is a multiple of four bytes.
 *
 * `writeBuffer` rejects any size that is not, so a mesh with an odd index
 * count — an odd triangle count, which the decimator is free to produce —
 * fails to upload at all. Appending one degenerate triangle keeps the count a
 * whole number of triangles and rasterises nothing.
 */
function padTriangleIndices(indices: Uint16Array): Uint16Array {
  if (indices.byteLength % 4 === 0) return indices;
  const padded = new Uint16Array(indices.length + 3);
  padded.set(indices);
  // Three copies of one vertex: zero area, so it never reaches the fragment
  // stage. `indices[0]` is always in range; the caller rejects empty meshes.
  padded.fill(indices[0]!, indices.length);
  return padded;
}

function triangleEdges(indices: Uint16Array): Uint16Array {
  const edges = new Set<number>();
  const result: number[] = [];
  const append = (a: number, b: number) => {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    const key = start * 0x10000 + end;
    if (edges.has(key)) return;
    edges.add(key);
    result.push(start, end);
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    append(indices[triangle]!, indices[triangle + 1]!);
    append(indices[triangle + 1]!, indices[triangle + 2]!);
    append(indices[triangle + 2]!, indices[triangle]!);
  }
  return new Uint16Array(result);
}

function destroyAll(resources: readonly (object | undefined)[]): void {
  let failed = false;
  let failure: unknown;
  for (const resource of resources) {
    try {
      (resource as { destroy?: () => void } | undefined)?.destroy?.();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
}

/**
 * Builds the landing page's glass as a rounded triangular prism — two triangular
 * faces and three rectangular ones — from the same cross-section the light
 * pipeline extrudes.
 *
 * vgpu authors the shape in its own units; this scales it to the world the
 * landing camera already frames (standing on y = -0.333, apex just under y = 1)
 * and centres it on z = 0, then packs it into the HGP1 layout the glass shaders
 * read. Building it here rather than shipping a `.mesh` keeps one definition of
 * the shape for both pipelines.
 */
export function createGlassPrismGeometry(gpu: Gpu) {
  const { vertices, indices } = prismMeshData();
  const positions = new Float32Array(vertices.length / 2);
  const normals = new Float32Array(vertices.length / 2);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex * 6 < vertices.length; vertex++) {
    for (let axis = 0; axis < 3; axis++) {
      const value =
        vertices[vertex * 6 + axis]! * GLASS_PRISM_SCALE + GLASS_PRISM_OFFSET[axis]!;
      positions[vertex * 3 + axis] = value;
      normals[vertex * 3 + axis] = vertices[vertex * 6 + 3 + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }

  const count = positions.length / 3;
  const data = new Uint8Array(count * 16);
  const view = new DataView(data.buffer);
  const span = [0, 1, 2].map((axis) => max[axis]! - min[axis]! || 1);
  const unorm = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 65535);
  const snorm = (value: number) => Math.round(Math.min(1, Math.max(-1, value)) * 32767);
  for (let vertex = 0; vertex < count; vertex++) {
    const offset = vertex * 16;
    for (let axis = 0; axis < 3; axis++) {
      view.setUint16(
        offset + axis * 2,
        unorm((positions[vertex * 3 + axis]! - min[axis]!) / span[axis]!),
        true
      );
      view.setInt16(offset + 8 + axis * 2, snorm(normals[vertex * 3 + axis]!), true);
    }
    view.setUint16(offset + 6, 65535, true); // occlusion: the glass shell has none
    view.setInt16(offset + 14, 0, true);
  }

  const buffers: GeometryBufferOptions[] = [
    {
      data,
      stride: 16,
      attributes: { packed_position: "unorm16x4", packed_normal: "snorm16x4" },
    },
  ];
  const solid = geometry(gpu, {
    label: "homepage-light-glass-prism",
    buffers,
    indices: padTriangleIndices(indices),
  });
  try {
    return {
      geometry: solid,
      wireframeGeometry: geometry(gpu, {
        label: "homepage-light-glass-prism-wireframe",
        topology: "line-list",
        buffers,
        indices: triangleEdges(indices),
      }),
      meshMin: min as readonly [number, number, number],
      meshMax: max as readonly [number, number, number],
    };
  } catch (error) {
    solid.destroy();
    throw error;
  }
}
