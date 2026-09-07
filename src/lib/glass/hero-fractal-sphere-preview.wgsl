import {
  CeramicMaterial,
  presentCeramic,
  shadeCeramic,
} from "./hero-fractal-ceramic.wgsl";

struct PreviewParams {
  resolution: vec2f,
  material: CeramicMaterial,
}
@group(0) @binding(0) var<uniform> preview: PreviewParams;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = preview.resolution.x / max(preview.resolution.y, 1.0);
  var screen = uv * 2.0 - 1.0;
  screen.y = -screen.y;
  screen.x *= aspect;

  let ro = vec3f(0.0, 0.0, 3.1);
  let rd = normalize(vec3f(screen * 0.72, -1.0));
  let b = dot(ro, rd);
  let c = dot(ro, ro) - 1.0;
  let discriminant = b * b - c;

  let backdrop = vec3f(3.10, 3.04, 2.92);
  if (discriminant < 0.0) {
    return presentCeramic(backdrop);
  }

  let t = -b - sqrt(discriminant);
  if (t <= 0.0) {
    return presentCeramic(backdrop);
  }

  let point = ro + rd * t;
  let normal = normalize(point);
  return presentCeramic(shadeCeramic(
    point,
    normalize(-rd),
    normal,
    preview.material,
  ));
}
