// The lamp at the centre of the tesseract.
//
// There is no surface here. The light inside the shells used to be the shells
// themselves — the inner faces were emissive, which paints the answer on rather
// than lighting anything, and what it gives you is flat coloured panels
// wherever the body is open enough to see one. This is a body of light instead:
// a sphere of even density, added over whatever is already drawn, with nothing
// in it that can catch a highlight or show an edge. What you see of it is how far a line
// of sight travelled through it, which is a gradient and never a facet.
//
// Two falloffs over that same chord, because one cannot be both things at once:
// a tight one for the hot middle, and a wide one for the haze that surrounds
// it. The wide one is doing the work — it is what light in the air between the
// shells looks like, and the reason the shape reads as lit from inside rather
// than as holding a ball.
//
// Everything else the lamp does is `hero-core-light.wgsl`, which lights the
// ceramic and the glass from this same position with the same falloff.

struct CoreParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  color: vec3f,
  /** How much a line of sight straight through the middle lays on. */
  centre: f32,
  /** The same, for the wide soft falloff around it. */
  bloom: f32,
}
@group(0) @binding(0) var<uniform> params: CoreParams;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
};

@vertex fn vs_main(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
) -> VertexOut {
  let world = params.model * vec4f(position, 1.0);
  var out: VertexOut;
  out.position = params.viewProjection * world;
  out.worldPosition = world.xyz;
  out.worldNormal = normalize((params.model * vec4f(normal, 0.0)).xyz);
  return out;
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  // How far the line of sight travelled inside the sphere, as a share of its
  // diameter: all of it through the middle, none of it at the silhouette.
  let chord = clamp(dot(normalize(in.worldNormal), view), 0.0, 1.0);
  let hot = chord * chord;
  let glow = params.centre * hot * hot * hot * hot + params.bloom * hot;
  return vec4f(clamp(params.color * glow, vec3f(0.0), vec3f(1.0)), 1.0);
}
