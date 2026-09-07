// 1024x256, distance across x and wavelength down y: the filaments and the
// tail-off the projected spectrum is multiplied by.
import { beamColor, fbm } from "./bake-common.wgsl";

struct BakeParams {
  size: vec2f,
}
@group(0) @binding(0) var<uniform> params: BakeParams;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let pixel = floor(uv * params.size);
  let travel = pixel.x / max(params.size.x - 1.0, 1.0);
  let wavelength = 700.0 - (pixel.y / max(params.size.y - 1.0, 1.0)) * 300.0;
  let coarse = fbm(vec2f(travel * 18.0, wavelength * 0.018), 4u);
  let filament = 0.5 + 0.5 * sin(travel * 104.0 + wavelength * 0.071);
  let focus = 0.72 + coarse * 0.24 + filament * 0.04;
  let tail = 1.0 - smoothstep(0.58, 1.08, travel) * 0.44;
  let farNeutral = smoothstep(0.2, 0.88, travel) * 0.36;
  let spectral = beamColor(wavelength);
  let hue = spectral / max(max(spectral.r, spectral.g), max(spectral.b, 1e-5));
  let rgb = clamp(mix(hue, vec3f(1.0), farNeutral) * focus * tail, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, focus * tail);
}
