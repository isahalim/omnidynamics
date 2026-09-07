import {
  HERO_FLOOR_BAKE_EXTENT,
  HERO_FLOOR_Y,
  heroFloorContactDistance,
  heroSoftShadow,
} from "./hero-fractal-sdf.wgsl";
import {
  HERO_KEY_LIGHT_POSITION,
  HERO_KEY_LIGHT_RADIUS,
} from "./hero-fractal-light.wgsl";

struct Params {
  fractalScale: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

// Orthographic floor-space light bake. R stores soft visibility and G stores
// an intentionally fake contact AO that remains stable across camera changes.
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let floorPoint = vec2f(
    (uv.x * 2.0 - 1.0) * HERO_FLOOR_BAKE_EXTENT,
    (uv.y * 2.0 - 1.0) * HERO_FLOOR_BAKE_EXTENT,
  );
  let origin = vec3f(floorPoint.x, HERO_FLOOR_Y + 0.004, floorPoint.y);
  let fractalScale = max(params.fractalScale, 0.0001);
  let localOrigin = origin / fractalScale;
  let toLight = HERO_KEY_LIGHT_POSITION - origin;
  let lightDistance = length(toLight);
  let shadow = heroSoftShadow(
    localOrigin,
    toLight / lightDistance,
    lightDistance / fractalScale,
    HERO_KEY_LIGHT_RADIUS / fractalScale,
  );

  let contactDistance = heroFloorContactDistance(floorPoint / fractalScale) *
    fractalScale;
  let floorGap = (1.0 - fractalScale) / 3.0;
  let contact = exp(-contactDistance * 11.0 - floorGap * 12.0);
  let ao = 1.0 - contact * 0.20;
  return vec4f(shadow, ao, 0.0, 1.0);
}
