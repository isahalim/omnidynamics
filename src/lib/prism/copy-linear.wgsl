// Copies the backdrop HDR target into the scene target, unchanged, so the front
// glass can refract a resolved background it is also drawn over.
@group(0) @binding(0) var sceneTexture: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(sceneTexture, vec2i(position.xy), 0).rgb, 1.0);
}
