import { presentCeramic } from "./hero-fractal-presentation.wgsl";
import { heroGlassFaceCaustic } from "./hero-glass-face-caustic.wgsl";
import {
  rotateHeroEnvironmentDirection,
  sampleHeroEnvironment,
} from "./hero-glass-environment.wgsl";
import {
  HeroCoreLight,
  heroCoreDirection,
  heroCoreFalloff,
} from "./hero-core-light.wgsl";

struct GlassParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  meshMin: vec3f,
  meshMax: vec3f,
  resolution: vec2f,
  fractalScale: f32,
  ior: f32,
  reflectionStrength: f32,
  backOpacity: f32,
  absorption: vec3f,
  frostRadius: f32,
  dispersion: f32,
  iridescenceStrength: f32,
  iridescenceFrequency: f32,
  environmentRotation: mat4x4f,
  environmentExposure: f32,
  reflectionDebug: f32,
  /** The lamp standing inside the solid, at no strength when there is none. */
  core: HeroCoreLight,
}
@group(0) @binding(0) var<uniform> params: GlassParams;
@group(0) @binding(1) var environmentTexture: texture_2d_array<f32>;
@group(0) @binding(2) var environmentSampler: sampler;

// The two faces behind the solid carry the same caustic as the two in front,
// weaker: they are read through the glass by the transmission pass, which
// refracts and frosts them, so they only have to be there.
const FACE_CAUSTIC_STRENGTH = 0.5;
const FACE_CAUSTIC_TINT = vec3f(1.0, 0.982, 0.951);

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  /** The mesh's own coordinates, the frame the face caustic is written in. */
  @location(2) localPosition: vec3f,
  @location(3) localNormal: vec3f,
};

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
) -> VertexOut {
  let localPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  let world = params.model * vec4f(localPosition, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(packed_normal.xyz, 0.0)).xyz);
  out.localPosition = localPosition;
  out.localNormal = packed_normal.xyz;
  return out;
}

fn studio(direction: vec3f) -> vec3f {
  return sampleHeroEnvironment(
    environmentTexture,
    environmentSampler,
    rotateHeroEnvironmentDirection(direction, params.environmentRotation),
  ) * params.environmentExposure * params.reflectionStrength;
}

fn premultiplied(color: vec3f, alpha: f32) -> vec4f {
  return vec4f(color * alpha, alpha);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let rawNormal = normalize(in.worldNormal);
  let view = normalize(params.cameraPosition - in.worldPosition);
  let normal = select(-rawNormal, rawNormal, dot(rawNormal, view) >= 0.0);
  let incident = -view;
  let facing = clamp(dot(view, normal), 0.0, 1.0);
  let reflected = studio(reflect(incident, normal));
  let alpha = clamp(
    params.backOpacity * (0.22 + 0.78 * pow(1.0 - facing, 1.5)),
    0.0,
    0.85,
  );
  // The face this fragment belongs to is chosen from the raw outward normal,
  // not the one flipped toward the camera: flipped, every back face would be
  // assigned to the face opposite it and carry that face's pattern.
  let faceCaustic = heroGlassFaceCaustic(in.localPosition, in.localNormal);
  // And what the lamp inside the solid throws on the far shell, which the front
  // interface reads back through the glass. The incidence is taken against the
  // outward normal rather than the one flipped toward the camera: light from
  // inside arrives on the inner side of the face, so the angle it arrives at is
  // the one the outward normal states, back to front.
  let coreIncidence = clamp(
    -dot(rawNormal, heroCoreDirection(params.core, in.worldPosition)),
    0.0,
    1.0,
  );
  let coreLit = params.core.color * params.core.strength *
    heroCoreFalloff(params.core, in.worldPosition) * coreIncidence;
  let lit = presentCeramic(reflected).rgb +
    FACE_CAUSTIC_TINT * faceCaustic * FACE_CAUSTIC_STRENGTH +
    coreLit;
  return premultiplied(clamp(lit, vec3f(0.0), vec3f(1.0)), alpha);
}
