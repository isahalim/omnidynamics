// r = the authored window mask, gb = the prism's contact shadow and occlusion.
import { grounding, overheadLight } from "./bake-common.wgsl";

struct BakeParams {
  /** 1 when the authored mask loaded, 0 to fall back to the procedural pools. */
  useMask: f32,
  /** How hard the solid darkens the plaster where it meets it. */
  contactStrength: f32,
  /** The glass's wall-facing outline, in the local units of this bake. */
  apex: vec2f,
  left: vec2f,
  right: vec2f,
}
@group(0) @binding(0) var<uniform> params: BakeParams;
@group(0) @binding(1) var wallMask: texture_2d<f32>;
@group(0) @binding(2) var wallMaskSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let masked = textureSampleLevel(wallMask, wallMaskSampler, uv, 0.0).r;
  let globalLight = select(overheadLight(uv), masked, params.useMask > 0.5);
  let contact = grounding(
    uv * 2.0 - 1.0,
    params.apex,
    params.left,
    params.right,
    params.contactStrength,
  );
  let edgeDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let edgeFade = smoothstep(0.0, 0.06, edgeDistance);
  return vec4f(globalLight * edgeFade, contact, 1.0);
}
