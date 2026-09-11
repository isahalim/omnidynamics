// The lamp at the centre of the tesseract.
//
// There is no surface here. The light inside the shells used to be the shells
// themselves — the inner faces were emissive, which paints the answer on rather
// than lighting anything, and what it gives you is flat coloured panels
// wherever the body is open enough to see one. This is a body of light instead:
// a sphere of even density, added over whatever is already drawn, with nothing
// in it that can catch a highlight or show an edge. What you see of it is how
// far a line of sight travelled through it, which is a gradient and never a
// facet.
//
// It is written as a star, which is the one thing everyone has seen that is
// this: a point far past white, a corona falling away around it, and no edge
// anywhere. Two profiles over the distance out from the middle, because one
// curve cannot be both — a tight gaussian for the core, and a wide soft
// shoulder for the corona. The core is pushed past what the image can hold, so
// the middle clips to white over a small disc and the gradient starts just
// outside it; that clipping is the whole effect, and is what the eye reads as
// something too bright to look at rather than as a pale ball.
//
// Everything else the lamp does is `hero-core-light.wgsl`, which lights the
// ceramic and the glass from this same position with the same falloff.

struct CoreParams {
  viewProjection: mat4x4f,
  model: mat4x4f,
  cameraPosition: vec3f,
  color: vec3f,
  /**
   * How much the middle lays on. Past 1 it clips to white, which is what makes
   * it a star rather than a lamp.
   */
  centre: f32,
  /** The same, for the corona around it. */
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

/**
 * How tightly the core is held in, and how fast the corona falls away.
 *
 * The core is wide enough to be seen through a gap between two shells rather
 * than only along the one line of sight that runs dead through the middle —
 * what gets out of a body like this is never the whole of anything.
 */
const CORE_TIGHTNESS = 13.0;
const CORONA_FALLOFF = 1.9;

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let view = normalize(params.cameraPosition - in.worldPosition);
  // How far out from the middle this line of sight passes, as a share of the
  // radius: 0 dead centre, 1 at the silhouette. On a sphere the angle between
  // the surface normal and the eye is exactly that, so it comes out of the one
  // dot product without a projection.
  let facing = clamp(dot(normalize(in.worldNormal), view), 0.0, 1.0);
  let radius = sqrt(max(0.0, 1.0 - facing * facing));
  let core = exp(-radius * radius * CORE_TIGHTNESS);
  let corona = pow(max(0.0, 1.0 - radius), CORONA_FALLOFF);
  let glow = params.centre * core + params.bloom * corona;
  return vec4f(clamp(params.color * glow, vec3f(0.0), vec3f(1.0)), 1.0);
}
