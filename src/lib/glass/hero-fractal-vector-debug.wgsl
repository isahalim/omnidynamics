import {
  heroFractalFaceNormal,
  heroFractalFacePosition,
  heroFractalSkillRotation,
  heroFractalSphereMix,
  heroFractalSphereNormal,
  heroFractalSpherePosition,
} from "./hero-fractal-face-instance.wgsl";

struct Params {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  meshMin: vec3f,
  meshMax: vec3f,
  sphereMix: f32,
  time: f32,
  environmentRotation: mat4x4f,
  mode: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex fn vs_main(
  @location(0) packed_position: vec4f,
  @location(1) packed_normal: vec4f,
  @location(2) packed_sphere: vec4f,
  @builtin(instance_index) instance: u32,
) -> VertexOut {
  let decodedPosition = mix(params.meshMin, params.meshMax, packed_position.xyz);
  let sphereMix = heroFractalSphereMix(decodedPosition, params.sphereMix);
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
  let localPosition = transitionRotation * mix(
    fractalPosition,
    spherePosition,
    sphereMix,
  );
  let fractalNormal = heroFractalFaceNormal(packed_normal.xyz, instance);
  let localNormal = transitionRotation * normalize(mix(
      fractalNormal,
      sphereNormal,
      sphereMix,
    ));
  let world = params.model * vec4f(localPosition, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(localNormal, 0.0)).xyz);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let normal = normalize(in.worldNormal);
  let view = normalize(params.cameraPosition - in.worldPosition);
  let reflected = reflect(-view, normal);
  let diffuseEnvironmentDirection = normalize(
    (params.environmentRotation * vec4f(normal, 0.0)).xyz,
  );
  let reflectionEnvironmentDirection = normalize(
    (params.environmentRotation * vec4f(reflected, 0.0)).xyz,
  );
  var direction = normal;
  if (params.mode > 1.5) {
    direction = reflectionEnvironmentDirection;
  } else if (params.mode > 0.5) {
    direction = diffuseEnvironmentDirection;
  }
  return vec4f(direction * 0.5 + vec3f(0.5), 1.0);
}
