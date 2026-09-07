import {
  HeroFloorAoSettings,
  heroFloorAo,
} from "./hero-fractal-floor-ao.wgsl";
import { presentCeramic } from "./hero-fractal-presentation.wgsl";
import { shadeWall } from "./hero-wall.wgsl";

// World units per material tile: vgpu uses prismSide * 2.4.
const WALL_WORLD_SCALE = 3.4;
// Tile density for the backdrop, which is read as a head-on wall. The uv is
// normalised by the resolution, so a tile is a fixed share of the viewport and
// the tooth keeps its size across display densities. This was tuned when the
// canvas was a 68vh frame; the canvas is now the whole viewport, and vgpu's
// wall is finer-grained than that value left ours.
const WALL_SCREEN_SCALE = 5.2;

// vgpu's light pipeline paints the wall #d2ccc2 (read off the wall nodes on
// vgpu.sh/?debug). `WALL_COLOR` is the linear albedo that lands on that sRGB
// value once `presentCeramic`'s ACES curve and gamma have been applied to the
// baked plaster's mean response — `node scripts/check-wall-color.mjs` derives
// it and prints the falloff range below.
const WALL_COLOR = vec3f(0.775, 0.681, 0.560);
const WALL_LIGHT_PEAK = 1.04;
const WALL_LIGHT_FALLOFF = 0.80;

const HERO_FLOOR_Y = -0.33333333333;
// Rays that never meet the floor are pinned here so their UV gradients stay
// finite for the quad-wide derivative of the pixels that do hit it.
const FLOOR_MAX_DISTANCE = 64.0;

struct Params {
  resolution: vec2f,
  tanHalfFov: f32,
  cameraPosition: vec3f,
  cameraTarget: vec3f,
  cameraUp: vec3f,
  floorGrid: f32,
  fractalScale: f32,
  orbScale: f32,
  sphereMix: f32,
  glassAoScale: f32,
  glassAoAmplitude: f32,
  glassAoOpacity: f32,
  fractalAoScale: f32,
  fractalAoAmplitude: f32,
  fractalAoOpacity: f32,
  orbAoScale: f32,
  orbAoAmplitude: f32,
  orbAoOpacity: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var wallMaterial: texture_2d<f32>;
@group(0) @binding(2) var wallSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var out: VertexOut;
  out.position = vec4f(positions[index], 0.0, 1.0);
  return out;
}

fn cameraRay(uv: vec2f) -> vec3f {
  let forward = normalize(params.cameraTarget - params.cameraPosition);
  let right = normalize(cross(forward, params.cameraUp));
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

fn gridLine(coordinate: vec2f, spacing: f32, pixelFootprint: f32) -> f32 {
  let gridCoordinate = coordinate / spacing;
  let distanceToLine = abs(fract(gridCoordinate - 0.5) - 0.5);
  let distance = min(distanceToLine.x, distanceToLine.y);
  let width = clamp(pixelFootprint / spacing, 0.0005, 0.45);
  return 1.0 - smoothstep(width * 0.35, width, distance);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let uv = in.position.xy / max(params.resolution, vec2f(1.0));
  let ro = params.cameraPosition;
  let rd = cameraRay(uv);
  // A broad window pool anchored above the top-right corner, fading out before
  // the bottom edge. `uv.y` is 0 at the top, so the centre sits just off-screen
  // above the canvas, the way the light falls on vgpu.sh's own wall.
  let cornerDistance = length(vec2f(
    (uv.x - 0.78) * 0.85,
    (uv.y + 0.10) * 1.15,
  ));
  let lightPool = 1.0 - smoothstep(0.08, 1.0, cornerDistance);
  let wallTint = WALL_COLOR * mix(WALL_LIGHT_FALLOFF, WALL_LIGHT_PEAK, lightPool);
  // Aspect-corrected so the plaster never stretches with the viewport.
  let wallUv = vec2f(
    uv.x * params.resolution.x / max(params.resolution.y, 1.0),
    uv.y,
  ) * WALL_SCREEN_SCALE;
  let backdrop = shadeWall(
    wallUv,
    dpdx(wallUv),
    dpdy(wallUv),
    wallTint,
    wallMaterial,
    wallSampler,
  ).color;

  // The floor plane is intersected unconditionally so its UV gradients can be
  // taken here, in uniform control flow — `dpdx`/`dpdy` and the sampling they
  // feed are undefined once the shader is inside the ray-hit branch below.
  // Rays that travel up or away are pinned to a grazing hit far down the
  // plane, which is the same coarse mip the horizon wants anyway, and their
  // colour is discarded.
  let floorDenominator = min(rd.y, -0.0001);
  let floorT = (HERO_FLOOR_Y - ro.y) / floorDenominator;
  let floorPoint = ro + rd * clamp(floorT, 0.0, FLOOR_MAX_DISTANCE);
  let floorUv = floorPoint.xz / WALL_WORLD_SCALE;
  let floorUvDx = dpdx(floorUv);
  let floorUvDy = dpdy(floorUv);

  if (rd.y < -0.0001) {
    if (floorT > 0.0) {
      let floorAoSettings = HeroFloorAoSettings(
        params.glassAoScale,
        params.glassAoAmplitude,
        params.glassAoOpacity,
        params.fractalAoScale,
        params.fractalAoAmplitude,
        params.fractalAoOpacity,
        params.orbAoScale,
        params.orbAoAmplitude,
        params.orbAoOpacity,
      );
      let floorAo = heroFloorAo(
        floorPoint.xz,
        params.fractalScale,
        params.orbScale,
        params.sphereMix,
        floorAoSettings,
      );
      // The floor is the same plaster seen in perspective, so it takes world
      // coordinates rather than the backdrop's screen-space projection.
      var floorColor = shadeWall(
        floorUv,
        floorUvDx,
        floorUvDy,
        wallTint,
        wallMaterial,
        wallSampler,
      ).color;
      if (params.floorGrid > 0.5) {
        let pixelFootprint = max(
          floorT * params.tanHalfFov * 3.2 / max(params.resolution.y, 1.0),
          0.0001,
        );
        let minor = gridLine(floorPoint.xz, 0.25, pixelFootprint) * 0.62;
        let major = gridLine(floorPoint.xz, 1.0, pixelFootprint) * 0.90;
        let grid = max(minor, major);
        floorColor = mix(floorColor, vec3f(0.035), grid);
      }
      let presentedFloor = presentCeramic(floorColor);
      return vec4f(presentedFloor.rgb * floorAo, presentedFloor.a);
    }
  }
  return presentCeramic(backdrop);
}
