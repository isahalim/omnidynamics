// The light that got through the glass, landing inside its own shadow.
//
// A solid of clear glass does not block the key light, it bends it: the beam
// that entered leaves turned, and piles up on the plaster as a bright figure
// inside the darker silhouette. Drawn additively over the cast shadow, this is
// what tells the eye the shape is transparent — without it a shadow that solid
// reads as a piece of stone.
//
// The mesh carries the shape of the pool; `glow` is 1 along the fold at its own
// edge, where the beam is most concentrated, and falls away either side.
struct HeroCaustic {
  viewProjection: mat4x4f,
  color: vec3f,
  strength: f32,
  /** Sharpens the fold: higher keeps the bright edge and dims the rest. */
  falloff: f32,
}

@group(0) @binding(0) var<uniform> caustic: HeroCaustic;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) glow: f32,
};

@vertex
fn vs_main(@location(0) position: vec2f, @location(1) glow: f32) -> VertexOut {
  var out: VertexOut;
  out.position = caustic.viewProjection * vec4f(position, 0.0, 1.0);
  out.glow = glow;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let shaped = pow(clamp(in.glow, 0.0, 1.0), max(caustic.falloff, 0.001));
  return vec4f(caustic.color * shaped * caustic.strength, 1.0);
}
