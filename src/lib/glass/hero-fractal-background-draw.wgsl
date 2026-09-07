import { presentCeramic } from "./hero-fractal-presentation.wgsl";
import { shadeWall } from "./hero-wall.wgsl";

// The backdrop is a wall, not a floor. vgpu's light pipeline draws its wall as
// one full-screen pass — "Coverage: full screen" on the wall draw node — with
// the prism floating in front of it and its shadow falling on the wall behind.
// An earlier version raymarched a horizontal plane here, which read as a floor
// the prism stood on: the plaster rushed away in perspective toward a horizon
// and the shape sat in a contact pool. Everything below is in the wall plane,
// which faces the camera.

// Tile density for the wall. The uv is normalised by the resolution, so a tile
// is a fixed share of the viewport and the tooth keeps its size across display
// densities.
const WALL_SCREEN_SCALE = 5.2;

// vgpu's light pipeline paints the wall #d2ccc2 (read off the wall nodes on
// vgpu.sh/?debug). `WALL_COLOR` is the linear albedo that lands on that sRGB
// value once `presentCeramic`'s ACES curve and gamma have been applied to the
// baked plaster's mean response — `node scripts/check-wall-color.mjs` derives
// it.
const WALL_COLOR = vec3f(0.775, 0.681, 0.560);

// Light balance. vgpu's wall draw exposes shadow floor 0.87, highlight
// exposure 3.31 and ambient fill 0.42, but those feed its own HDR wall pass —
// the numbers do not transfer to a shader with a different tone chain, and
// taken literally the shadow only removed 13% and vanished. These are named
// for what they do here and tuned against vgpu's rendered wall: the lit pools
// sit a little above the #d2ccc2 base and the shadow core a little under it.
const AMBIENT_FILL = 0.86;
const HIGHLIGHT_GAIN = 0.30;
/** How much light survives in the core of the cast shadow. */
const SHADOW_FLOOR = 0.62;

// The global light is a baked lightmap of window patches on vgpu's wall; the
// pools below reproduce those procedurally. LIGHTMAP TRANSFER on that node
// reads gamma 0.65, contrast 6.85, pivot 0.9 — a curve that lifts the midtones
// and then rolls off, rather than the hard clamp a literal reading produced.
const LIGHTMAP_GAMMA = 0.65;
const LIGHTMAP_CONTRAST = 0.685;
const LIGHTMAP_PIVOT = 0.45;

// Every vec2f first, then the scalars: vec2f aligns to 8 bytes, so a scalar
// sitting between two of them opens a padding hole that is easy to get wrong
// on one side or the other. In this order the struct packs with none.
struct Params {
  resolution: vec2f,
  // Where the prism sits on the wall and how big it is, in aspect-corrected
  // screen units. The shadow is cast from this rather than from depth: vgpu
  // draws its own from a dedicated "analytic core and penumbra" mesh for the
  // same reason — a soft, art-directable shadow rather than a hard one.
  prismCenter: vec2f,
  prismHalfExtent: vec2f,
  shadowOffset: vec2f,
  shadowSoftness: f32,
  shadowOpacity: f32,
  contactOpacity: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var wallMaterial: texture_2d<f32>;
@group(0) @binding(2) var wallSampler: sampler;

struct VertexOut {
  @builtin(position) position: vec4f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var out: VertexOut;
  out.position = vec4f(positions[index], 0.0, 1.0);
  return out;
}

/** Signed distance to the triangle through three points, negative inside. */
fn triangleDistance(p: vec2f, a: vec2f, b: vec2f, c: vec2f) -> f32 {
  let e0 = b - a;
  let e1 = c - b;
  let e2 = a - c;
  let v0 = p - a;
  let v1 = p - b;
  let v2 = p - c;
  let q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let winding = sign(e0.x * e2.y - e0.y * e2.x);
  let d = min(
    min(
      vec2f(dot(q0, q0), winding * (v0.x * e0.y - v0.y * e0.x)),
      vec2f(dot(q1, q1), winding * (v1.x * e1.y - v1.y * e1.x)),
    ),
    vec2f(dot(q2, q2), winding * (v2.x * e2.y - v2.y * e2.x)),
  );
  return -sqrt(d.x) * sign(d.y);
}

/**
 * The prism's silhouette, as the triangle inscribed in its projected box.
 *
 * Placing an equilateral triangle by its centroid instead put the shadow a
 * sixth of its height too high and made it wider than the shape casting it;
 * the box is what the projection actually measured, so the silhouette is
 * built from it directly.
 */
fn prismSilhouette(point: vec2f, center: vec2f) -> f32 {
  let half = max(params.prismHalfExtent, vec2f(0.0001));
  return triangleDistance(
    point,
    center + vec2f(0.0, half.y),
    center + vec2f(-half.x, -half.y),
    center + vec2f(half.x, -half.y),
  );
}

/**
 * The prism's shadow on the wall. vgpu splits this into a core and a penumbra;
 * the same two terms fall out of widening the silhouette twice — a tight dark
 * core, and a broad wash that reaches much further and carries the softness.
 */
fn prismShadow(wallPoint: vec2f) -> f32 {
  let distance = prismSilhouette(
    wallPoint,
    params.prismCenter + params.shadowOffset,
  );
  let softness = max(params.shadowSoftness, 0.0001);
  let core = 1.0 - smoothstep(0.0, softness, distance);
  let penumbra = 1.0 - smoothstep(
    -params.prismHalfExtent.x * 0.2,
    softness * 3.6,
    distance,
  );
  return clamp(
    (core + penumbra * 0.55) * params.shadowOpacity,
    0.0,
    1.0,
  );
}

/**
 * Occlusion where the prism nearly meets the wall. Unlike the cast shadow this
 * one is not offset — it hugs the silhouette, which is what stops the shape
 * reading as a sticker laid on flat paint.
 */
fn contactOcclusion(wallPoint: vec2f) -> f32 {
  let distance = prismSilhouette(wallPoint, params.prismCenter);
  let reach = max(params.prismHalfExtent.x, 0.0001) * 0.85;
  return (1.0 - smoothstep(0.0, reach, distance)) * params.contactOpacity;
}

/** One broad, soft pool, weighted per axis so it reads as a window. */
fn pool(wallPoint: vec2f, center: vec2f, shape: vec2f, falloff: f32) -> f32 {
  let d = (wallPoint - center) * shape;
  return exp(-dot(d, d) * falloff);
}

/**
 * Broad window light on the wall: a near pool and a weaker far one, put
 * through the same gamma/contrast/pivot transfer vgpu applies to its baked
 * lightmap.
 */
fn globalLight(wallPoint: vec2f) -> f32 {
  let pooled = clamp(
    pool(wallPoint, vec2f(-0.62, 0.30), vec2f(1.05, 1.50), 1.50) * 0.85 +
      pool(wallPoint, vec2f(0.52, -0.42), vec2f(0.85, 1.25), 1.15) * 0.55,
    0.0,
    1.0,
  );
  let shaped = pow(pooled, LIGHTMAP_GAMMA);
  // Contrast about the pivot, the way that transfer curve bends.
  return clamp(
    LIGHTMAP_PIVOT + (shaped - LIGHTMAP_PIVOT) * (1.0 + LIGHTMAP_CONTRAST),
    0.0,
    1.0,
  );
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let uv = in.position.xy / max(params.resolution, vec2f(1.0));
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  // Aspect-corrected wall coordinates, centred on the canvas and y-up, so the
  // plaster never stretches and the prism's footprint lands where the camera
  // projected it.
  let wallPoint = vec2f((uv.x - 0.5) * aspect, 0.5 - uv.y);

  let wallUv = wallPoint * WALL_SCREEN_SCALE;
  let wallUvDx = dpdx(wallUv);
  let wallUvDy = dpdy(wallUv);

  let light = globalLight(wallPoint);
  let shadow = prismShadow(wallPoint);
  let contact = contactOcclusion(wallPoint);
  // Light balance in vgpu's terms: the global light is exposed up, the shadow
  // and contact terms take it back down, and the ambient fill keeps the
  // deepest part of the shadow off black.
  let exposure = AMBIENT_FILL + light * HIGHLIGHT_GAIN;
  let occlusion = mix(1.0, SHADOW_FLOOR, clamp(shadow + contact, 0.0, 1.0));
  let wallTint = WALL_COLOR * exposure * occlusion;

  let wall = shadeWall(
    wallUv,
    wallUvDx,
    wallUvDy,
    wallTint,
    wallMaterial,
    wallSampler,
  ).color;
  return presentCeramic(wall);
}
