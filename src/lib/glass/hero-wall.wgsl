// Plaster wall shading, ported from vgpu's prism-background wall pass.
// The baked material packs: r = albedo variation, gb = tangent-space normal XY,
// a = roughness. Two samples at different frequencies give the coarse trowel
// undulation and the fine tooth; scratches ride in the same height field.

// vgpu's light-pipeline values, read from the wall nodes on vgpu.sh/?debug.
const WALL_NORMAL_STRENGTH = 0.6;
const WALL_MICRO_FREQUENCY = 7.0;
const WALL_MICRO_STRENGTH = 1.05;
const WALL_AMBIENT = 0.5;
const WALL_LIGHT_DIRECTION = vec3f(-0.48, 0.56, 0.68);

fn normalFromXy(normalXy: vec2f) -> vec3f {
  let limited = normalXy / max(length(normalXy), 1.0);
  return normalize(vec3f(
    limited,
    sqrt(max(1.0 - dot(limited, limited), 0.0001)),
  ));
}

struct WallShade {
  color: vec3f,
  roughness: f32,
}

/**
 * Lights one point of plaster. `uv` is in tile units; callers pass world
 * coordinates for the floor and screen coordinates for the backdrop, which is
 * viewed near head-on.
 *
 * The caller supplies the UV gradients rather than letting the sampler take
 * them implicitly: the floor is shaded inside a ray-hit branch, and
 * `textureSample` may only be called from uniform control flow. `dpdx`/`dpdy`
 * run in the caller's uniform scope and the mip chain is still selected
 * per-pixel, which is what keeps the receding floor from aliasing.
 */
export fn shadeWall(
  uv: vec2f,
  uvDx: vec2f,
  uvDy: vec2f,
  tint: vec3f,
  wallMaterial: texture_2d<f32>,
  wallSampler: sampler,
) -> WallShade {
  let material = textureSampleGrad(wallMaterial, wallSampler, uv, uvDx, uvDy);
  // The micro layer is offset so it never lines up with the coarse pattern.
  // Its gradients scale with the frequency so it picks the matching mip.
  let microMaterial = textureSampleGrad(
    wallMaterial,
    wallSampler,
    uv * WALL_MICRO_FREQUENCY + vec2f(0.371, 0.613),
    uvDx * WALL_MICRO_FREQUENCY,
    uvDy * WALL_MICRO_FREQUENCY,
  );

  let largeXy = (material.gb * 2.0 - 1.0) * WALL_NORMAL_STRENGTH;
  let microXy = (microMaterial.gb * 2.0 - 1.0) * WALL_MICRO_STRENGTH;
  let normal = normalFromXy(largeXy + microXy);

  let lightDirection = normalize(WALL_LIGHT_DIRECTION);
  let lightFacing = max(dot(normal, lightDirection), 0.0);
  let diffuse = mix(WALL_AMBIENT, 1.0, lightFacing);

  // Grazing sheen picks out the tooth; rougher plaster scatters it wider.
  let halfDirection = normalize(lightDirection + vec3f(0.0, 0.0, 1.0));
  let specularPower = mix(48.0, 4.0, material.a);
  let specular = pow(max(dot(normal, halfDirection), 0.0), specularPower)
    * mix(0.12, 0.025, material.a);

  let albedo = tint * material.r;
  return WallShade(albedo * diffuse + vec3f(specular), material.a);
}
