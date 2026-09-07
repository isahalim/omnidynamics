import {
  heroFractalNormal,
  traceHeroFractal,
} from "./hero-fractal-sdf.wgsl";

struct DepthParams {
  resolution: vec2f,
  tanHalfFov: f32,
  cameraRotation: vec3f,
  cameraDistance: vec3f,
  cameraTarget: vec3f,
}
@group(0) @binding(0) var<uniform> params: DepthParams;

fn rotateCamera(vector: vec3f, rotation: vec3f) -> vec3f {
  let cz = cos(rotation.z);
  let sz = sin(rotation.z);
  let rolled = vec3f(
    cz * vector.x - sz * vector.y,
    sz * vector.x + cz * vector.y,
    vector.z,
  );
  let cx = cos(rotation.x);
  let sx = sin(rotation.x);
  let pitched = vec3f(
    rolled.x,
    cx * rolled.y + sx * rolled.z,
    -sx * rolled.y + cx * rolled.z,
  );
  let cy = cos(rotation.y);
  let sy = sin(rotation.y);
  return vec3f(
    cy * pitched.x + sy * pitched.z,
    pitched.y,
    -sy * pitched.x + cy * pitched.z,
  );
}

fn cameraRay(uv: vec2f) -> vec3f {
  let ro = params.cameraTarget + rotateCamera(
    params.cameraDistance,
    params.cameraRotation,
  );
  let cameraUp = rotateCamera(vec3f(0.0, 1.0, 0.0), params.cameraRotation);
  let forward = normalize(params.cameraTarget - ro);
  let right = normalize(cross(forward, cameraUp));
  let up = normalize(cross(right, forward));
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  var screen = uv * 2.0 - 1.0;
  screen.y = -screen.y;
  let localRay = normalize(vec3f(
    screen.x * aspect * params.tanHalfFov,
    screen.y * params.tanHalfFov,
    -1.0,
  ));
  return normalize(mat3x3f(right, up, -forward) * localRay);
}

struct GeometryBake {
  @location(0) depth: f32,
  @location(1) normal: vec4f,
}

@fragment fn fs_main(@location(0) uv: vec2f) -> GeometryBake {
  let ro = params.cameraTarget + rotateCamera(
    params.cameraDistance,
    params.cameraRotation,
  );
  let rd = cameraRay(uv);
  let depth = traceHeroFractal(ro, rd, 6.0);
  if (depth <= 0.0) {
    return GeometryBake(0.0, vec4f(0.5, 0.5, 1.0, 1.0));
  }

  var normal = heroFractalNormal(ro + rd * depth);
  if (dot(normal, -rd) < 0.0) { normal = -normal; }
  return GeometryBake(
    depth,
    vec4f(normal * 0.5 + vec3f(0.5), 1.0),
  );
}
