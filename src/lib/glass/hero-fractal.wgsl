import {
  HERO_FLOOR_BAKE_EXTENT,
  HERO_FLOOR_Y,
} from "./hero-fractal-sdf.wgsl";
import {
  CeramicMaterial,
  presentCeramic,
  shadeCeramic,
} from "./hero-fractal-ceramic.wgsl";

struct Params {
  resolution: vec2f,
  tanHalfFov: f32,
  cameraRotation: vec3f,
  cameraDistance: vec3f,
  cameraTarget: vec3f,
  material: CeramicMaterial,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;
@group(0) @binding(2) var normalTexture: texture_2d<f32>;
@group(0) @binding(3) var floorBakeTexture: texture_2d<f32>;
@group(0) @binding(4) var floorSampler: sampler;

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

fn cameraOrigin() -> vec3f {
  return params.cameraTarget + rotateCamera(
    params.cameraDistance,
    params.cameraRotation,
  );
}

fn cameraRay(uv: vec2f) -> vec3f {
  let ro = cameraOrigin();
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

fn loadDepth(pixel: vec2i) -> f32 {
  return textureLoad(depthTexture, pixel, 0).r;
}

fn floorLighting(point: vec3f) -> vec2f {
  let uv = point.xz / (2.0 * HERO_FLOOR_BAKE_EXTENT) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return vec2f(1.0);
  }
  return textureSampleLevel(floorBakeTexture, floorSampler, uv, 0.0).rg;
}

@fragment fn fs_main(
  @location(0) uv: vec2f,
  @builtin(position) fragmentPosition: vec4f,
) -> @location(0) vec4f {
  let pixel = vec2i(fragmentPosition.xy);
  let depth = loadDepth(pixel);
  let ro = cameraOrigin();
  let rd = cameraRay(uv);
  let backdrop = vec3f(3.10, 3.04, 2.92);

  if (depth > 0.0) {
    let view = normalize(-rd);
    let normal = normalize(
      textureLoad(normalTexture, pixel, 0).rgb * 2.0 - vec3f(1.0)
    );
    return presentCeramic(shadeCeramic(
      ro + rd * depth,
      view,
      normal,
      params.material,
    ));
  }

  if (rd.y < -0.0001) {
    let floorT = (HERO_FLOOR_Y - ro.y) / rd.y;
    if (floorT > 0.0) {
      let baked = floorLighting(ro + rd * floorT);
      let shadowTone = mix(0.16, 1.0, smoothstep(0.0, 1.0, baked.x));
      return presentCeramic(backdrop * shadowTone * baked.y);
    }
  }
  return presentCeramic(backdrop);
}
