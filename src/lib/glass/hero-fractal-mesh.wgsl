import { presentCeramic } from "./hero-fractal-presentation.wgsl";
import {
  heroFractalFaceNormal,
  heroFractalFacePosition,
  heroFractalMorphMix,
  heroFractalSkillRotation,
  heroFractalWholeMeshMorph,
  heroFractalSphereNormal,
  heroFractalSpherePosition,
} from "./hero-fractal-face-instance.wgsl";
import {
  rotateHeroEnvironmentDirection,
  sampleHeroEnvironmentLevel,
} from "./hero-glass-environment.wgsl";

const RUBBER_F0 = vec3f(0.028);

/**
 * How many rigid parts a model mesh can be posed in, and the divisor its part
 * index is stored under in `packed_normal.w`. Both have to match
 * `scripts/build-meshes.mjs`, which writes the tag, and `../prism/rig.ts`,
 * which fills the table.
 */
const PART_SLOTS = 16;
const PART_SCALE = 64.0;

/**
 * What is added to that same lane for a vertex lit from within.
 *
 * The vertex layout is full, and a part index never reaches a quarter of the
 * lane's range, so the tag rides in the headroom above it: anything past
 * GLOW_THRESHOLD is glowing, and the index is what is left once the bias is
 * taken off. `scripts/build-meshes.mjs` writes it.
 */
const GLOW_BIAS = 0.5;
const GLOW_THRESHOLD = 0.25;

struct SoftRubberMaterial {
  baseColor: vec3f,
  roughness: f32,
  diffuseStrength: f32,
  specularStrength: f32,
  ambientStrength: f32,
}

/** What a vertex tagged as lit from within glows, and how hard. */
struct GlowMaterial {
  color: vec3f,
  strength: f32,
}

struct MeshParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  meshMin: vec3f,
  meshMax: vec3f,
  sphereMix: f32,
  /** 1 for a whole model mesh, 0 for the example's tetrahedron face. */
  wholeMesh: f32,
  time: f32,
  material: SoftRubberMaterial,
  glow: GlowMaterial,
  environmentRotation: mat4x4f,
  environmentExposure: f32,
  /**
   * Where each of the model's rigid parts stands this frame, in the mesh's own
   * coordinates — the rotor turned on its hub, the arm swung on its base, the
   * head turned toward the cursor. Slot 0 is the subject itself and is normally
   * the identity; every unused slot is one too, so a mesh with no rig poses as
   * the mesh it was baked as.
   */
  parts: array<mat4x4f, 16>,
}
@group(0) @binding(0) var<uniform> params: MeshParams;
@group(0) @binding(1) var environmentTexture: texture_2d_array<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) ambientOcclusion: f32,
  /**
   * How much of this vertex is lit from within: its own tag, faded out by the
   * morph. A triangle never straddles the tag — the materials it separates are
   * separate primitives all the way through the build — so this interpolates
   * across a face that is wholly one or wholly the other, and the orb every
   * shape resolves to carries no glow at all.
   */
  @location(3) glow: f32,
};

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
  @location(2) packed_sphere: vec4f,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  let bakedPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  // Only a model mesh carries a rig. vgpu's own fractal ships 1.0 in this lane,
  // which would read as a part it has no table for, so it is pinned to slot 0.
  let tagged = params.wholeMesh > 0.5;
  let glow = select(0.0, 1.0, tagged && packed_normal.w >= GLOW_THRESHOLD);
  let part = select(
    0,
    clamp(i32(round((packed_normal.w - glow * GLOW_BIAS) * PART_SCALE)), 0, PART_SLOTS - 1),
    tagged,
  );
  let pose = params.parts[part];
  // The pose is rigid, so it moves the normal with the same matrix, and the
  // sphere target is left where it is: every part resolves to the same orb.
  let decodedPosition = (pose * vec4f(bakedPosition, 1.0)).xyz;
  let posedNormal = (pose * vec4f(packed_normal.xyz, 0.0)).xyz;
  let sphereMix = heroFractalMorphMix(
    decodedPosition,
    params.sphereMix,
    params.wholeMesh,
  );
  let fractalPosition = heroFractalFacePosition(decodedPosition, instance);
  let sphereSourcePosition = heroFractalFacePosition(
    packed_sphere.xyz,
    instance,
  );
  let spherePosition = heroFractalSpherePosition(
    sphereSourcePosition,
    params.time,
  );
  let sphereNormal = heroFractalSphereNormal(sphereSourcePosition, params.time);
  let transitionRotation = heroFractalSkillRotation(sphereMix);
  let morphPosition = transitionRotation * mix(
    mix(fractalPosition, spherePosition, sphereMix),
    heroFractalWholeMeshMorph(fractalPosition, spherePosition, sphereMix),
    params.wholeMesh,
  );
  let fractalNormal = heroFractalFaceNormal(posedNormal, instance);
  let morphNormal = transitionRotation * normalize(mix(
      fractalNormal,
      sphereNormal,
      sphereMix,
    ));
  let world = params.model * vec4f(morphPosition, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(morphNormal, 0.0)).xyz);
  out.ambientOcclusion = mix(packed_position.w, packed_sphere.w, sphereMix);
  out.glow = glow * (1.0 - sphereMix);
  return out;
}

fn environment(direction: vec3f, level: f32) -> vec3f {
  return sampleHeroEnvironmentLevel(
    environmentTexture,
    environmentSampler,
    rotateHeroEnvironmentDirection(direction, params.environmentRotation),
    level,
  ) * params.environmentExposure;
}

fn fresnelSchlick(cosine: f32) -> vec3f {
  return RUBBER_F0 + (vec3f(1.0) - RUBBER_F0) *
    pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  // The generated mesh has consistent outward/cavity winding and is back-face
  // culled. Flipping this normal toward the camera makes diffuse lighting
  // discontinuously change as the orbit crosses a face plane.
  let normal = normalize(in.worldNormal);
  let roughness = clamp(params.material.roughness, 0.08, 1.0);
  let facing = clamp(dot(normal, view), 0.0, 1.0);
  let fresnel = fresnelSchlick(facing);
  let maxEnvironmentLevel = f32(textureNumLevels(environmentTexture) - 1u);

  // The environment is prefiltered once during asset loading. Diffuse uses a
  // broad irradiance-like level, while roughness selects progressively softer
  // studio reflections with a single lookup. Glass continues to sample level
  // zero, so its reflections stay sharp.
  let diffuseEnvironment = environment(normal, maxEnvironmentLevel * 0.72);
  let reflectedDirection = reflect(-view, normal);
  let specularEnvironment = environment(
    reflectedDirection,
    roughness * maxEnvironmentLevel,
  );
  // A part lit from within takes the glow's colour as its own as well, so what
  // the studio does reach it is the same colour as what it gives off — a core
  // that reads as hot rather than as a red lamp behind grey.
  let glow = clamp(in.glow, 0.0, 1.0);
  let baseColor = mix(params.material.baseColor, params.glow.color, glow);
  let diffuse = baseColor * diffuseEnvironment * (
    params.material.diffuseStrength + params.material.ambientStrength * 0.35
  );
  let specular = specularEnvironment * fresnel *
    params.material.specularStrength * mix(0.82, 0.34, roughness);
  let grazingSheen = baseColor * diffuseEnvironment *
    pow(1.0 - facing, 2.0) * roughness * 0.28;
  let ambientOcclusion = clamp(in.ambientOcclusion, 0.0, 1.0);
  let rubber = (diffuse * (vec3f(1.0) - fresnel) + grazingSheen) *
    ambientOcclusion + specular * mix(0.45, 1.0, ambientOcclusion);
  // Emission is the one term the studio has no say in and occlusion does not
  // dim: it is the surface's own light, brightest where it faces away.
  //
  // The spread matters more than the level. Red is already past white by the
  // time the tone curve sees it, so the falloff shows in the channels beside
  // it instead — deep red where a face is square on, running hot toward orange
  // where one turns away — and that gradient is the whole difference between a
  // core that glows and a surface painted red.
  let emission = params.glow.color * params.glow.strength * glow *
    mix(0.45, 1.3, 1.0 - facing);
  return presentCeramic(rubber + emission);
}
