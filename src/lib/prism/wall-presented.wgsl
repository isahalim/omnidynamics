// The same wall, tone mapped where it is drawn rather than at the end.
//
// The light pipeline keeps its backdrop in linear HDR and lets the presentation
// pass map it once. The landing page's glass is vgpu's glass-fractal material,
// which composites in display space — it screens studio panels over the
// transmitted scene and clamps — so the target it reads has to already hold
// presented colour. This applies exactly what `present.wgsl` would have: the
// pipeline's ACES curve and the same sRGB encode.
import { linearToSrgb3 } from "./color.wgsl";
import { applyPrismToneMapping } from "./tone-mapping.wgsl";
import { LightWall, evaluateWall, wallPoint } from "./wall-common.wgsl";

@group(0) @binding(0) var<uniform> params: LightWall;
@group(0) @binding(1) var wallMaterial: texture_2d<f32>;
@group(0) @binding(2) var wallLighting: texture_2d<f32>;
@group(0) @binding(3) var materialSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) worldPosition: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, 0.0),
  );
  let uv = corners[index];
  let position = wallPoint(params, uv);
  var out: VertexOut;
  out.position = params.viewProjection * vec4f(position, 0.0, 1.0);
  out.uv = uv;
  out.worldPosition = position;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let wall = evaluateWall(
    in.worldPosition,
    in.uv,
    params,
    wallMaterial,
    wallLighting,
    materialSampler,
  );
  let presented = linearToSrgb3(applyPrismToneMapping(max(wall.composed, vec3f(0.0)), 0u));
  return vec4f(presented, 1.0);
}
