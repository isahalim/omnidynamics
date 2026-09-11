// The lamp inside the glass, as everything it lights sees it.
//
// The tesseract carries a small sphere at its centre that is its own light
// source. Three surfaces have to answer to it — the ceramic shells around it,
// the glass they are all standing in, and the sphere itself — so what it is,
// and the falloff every one of them uses, are stated once here rather than
// three times over.
//
// It is a point light: no shadows, no occlusion, nothing traced. Inside a body
// of nested shells that is not the approximation it would be in the open —
// there is nothing between the core and a shell but the shells the light is
// already passing through, and they are open enough to see it through.

/** Where it stands, what it gives off, and how far that carries. */
export struct HeroCoreLight {
  /** In the same world as the surface being lit. */
  position: vec3f,
  color: vec3f,
  /** What it gives off at its own surface. */
  strength: f32,
  /** The distance at which it is down to half. */
  range: f32,
}

/** The direction from a point toward it. */
export fn heroCoreDirection(light: HeroCoreLight, position: vec3f) -> vec3f {
  let toward = light.position - position;
  return toward / max(length(toward), 0.0001);
}

/**
 * Its inverse-square falloff, written so nothing standing on top of it blows
 * out: a real one divides by the distance alone and runs away to infinity as
 * that goes to zero, and the nearest shell is a tenth of the core's range from
 * it. Adding the one keeps the light finite at the source and leaves the
 * square law intact everywhere it can be seen.
 */
export fn heroCoreFalloff(light: HeroCoreLight, position: vec3f) -> f32 {
  let distance = length(light.position - position) / max(light.range, 0.0001);
  return 1.0 / (1.0 + distance * distance);
}

/**
 * What arrives on a surface facing `normal`.
 *
 * `wrap` carries the light a little past the terminator, which is what a small
 * source of light close to a surface actually does — the core is a sphere a
 * seventh of the shape across rather than a point, so a face turned just away
 * from it still catches its edge. At 0 this is the ordinary cosine.
 */
export fn heroCoreIrradiance(
  light: HeroCoreLight,
  position: vec3f,
  normal: vec3f,
  wrap: f32,
) -> vec3f {
  let toward = dot(normal, heroCoreDirection(light, position));
  let lambert = clamp((toward + wrap) / (1.0 + wrap), 0.0, 1.0);
  return light.color * light.strength *
    heroCoreFalloff(light, position) * lambert;
}
