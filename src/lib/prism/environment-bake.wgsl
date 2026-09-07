// Rasterises the authored analytic studio into the equirectangular HDR texture
// layout the glass shaders sample.
import { direction_from_equirect } from "./environment-map-common.wgsl";
import { sampleStudioEnvironment } from "./environment.wgsl";

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(sampleStudioEnvironment(direction_from_equirect(uv)), 1.0);
}
