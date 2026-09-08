/**
 * The caustic light on the glass's own four faces. Ours, not the example's.
 *
 * Clear glass does not present flat, even faces to a lit room. Light that
 * crosses the solid is folded by the surfaces it passes through and piles up on
 * the inside of the face it leaves by, as a web of bright filaments — the same
 * figure `hero-caustic.wgsl` draws on the plaster, seen on the glass instead of
 * under it. Without it the tetrahedron reads as four flat grey triangles: a
 * diagram of a solid rather than a photograph of one, because nothing on a face
 * tells the eye which way that face is turned.
 *
 * Everything here is in the mesh's own coordinates — the frame the transmission
 * shader traces the solid in, the unit tetrahedron whose four faces lie on
 * `FACE_PLANE`. A fragment is assigned to the face its normal points along and
 * given a coordinate frame built from that face's own edge, so each face
 * carries a different piece of the web, at its own turn and scale, and two
 * faces meeting at an edge do not continue one another's pattern.
 *
 * Two masks keep the light on the flat of a face. `flatness` falls away across
 * the rounded edge, where the frame the pattern is generated in stops being the
 * face's; `edgeDistance` is the distance to the nearest of the three edges,
 * which fades the last of it out before the bevel and, just inside that, is
 * where the fold is brightest.
 */

/** Every face of the unit tetrahedron is this far from its centre. */
const FACE_PLANE = 0.33333333333;

/** How many folds of light cross a face. */
const CAUSTIC_FREQUENCY = 3.8;
const CAUSTIC_OCTAVES = 2u;
/** How tightly a fold is drawn: higher is a thinner, harder vein. */
const CAUSTIC_FILAMENT = 2.1;
/**
 * The pool: a slow swell across the face that most of the light lives in, and
 * the share of the face that is left outside it. Real glass does not carry an
 * even sheet of light — one part of a face is lit and the rest is barely
 * touched, and it is the difference between them that reads as a surface.
 */
const CAUSTIC_POOL_FREQUENCY = 1.05;
const CAUSTIC_POOL_FLOOR = 0.3;
/** The band inside an edge where the fold piles up, and how much it lifts. */
const CAUSTIC_RIM_WIDTH = 0.22;
const CAUSTIC_RIM_GAIN = 0.55;
/** Where the rounded edge takes the pattern back. */
const CAUSTIC_EDGE_FADE = vec2f(0.012, 0.075);
const CAUSTIC_FLAT_FADE = vec2f(0.9, 0.995);

struct HeroGlassFace {
  /** Which of the four faces the fragment belongs to. */
  index: u32,
  /** 1 on the flat of that face, falling to 0 across the rounded edge. */
  flatness: f32,
  /** Distance to the nearest of the face's three edges, in mesh units. */
  edgeDistance: f32,
  /** In-plane coordinates, centred on the face. */
  uv: vec2f,
}

/**
 * The face a fragment sits on, and its own frame.
 *
 * The four corners double as the face normals: the face opposite a corner has
 * that corner's direction reversed as its outward normal, and its centroid is
 * that normal at `FACE_PLANE`. The three planes a face is *not* on are its own
 * three edges, so the distance to the nearest of them is the distance to the
 * nearest edge without any triangle arithmetic.
 */
fn heroGlassFace(position: vec3f, normal: vec3f) -> HeroGlassFace {
  var corners = array<vec3f, 4>(
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.94280904158, -0.33333333333, 0.0),
    vec3f(-0.47140452079, -0.33333333333, 0.81649658093),
    vec3f(-0.47140452079, -0.33333333333, -0.81649658093),
  );

  var index = 0u;
  var flatness = -2.0;
  for (var i = 0u; i < 4u; i++) {
    let alignment = dot(normal, -corners[i]);
    if (alignment > flatness) {
      flatness = alignment;
      index = i;
    }
  }

  let outward = -corners[index];
  var edgeDistance = 100.0;
  for (var i = 0u; i < 4u; i++) {
    if (i == index) { continue; }
    edgeDistance = min(edgeDistance, FACE_PLANE - dot(-corners[i], position));
  }

  // One edge of the face gives the frame, so the pattern is laid out along the
  // triangle rather than along the world the solid happens to stand in.
  let tangent = normalize(corners[(index + 1u) % 4u] - corners[(index + 2u) % 4u]);
  let bitangent = cross(outward, tangent);
  let centred = position - outward * FACE_PLANE;

  var face: HeroGlassFace;
  face.index = index;
  face.flatness = flatness;
  face.edgeDistance = edgeDistance;
  face.uv = vec2f(dot(centred, tangent), dot(centred, bitangent));
  return face;
}

/**
 * The web itself: bands folded through their own gradient a few times, read at
 * their zero crossing.
 *
 * A caustic is where a smooth wavefront folds onto itself, so the bright part
 * is a curve rather than a blob. Pushing the plane sideways by a sine of itself
 * before the band is measured is what turns straight interference fringes into
 * the wandering cells; `1 - |band|` peaks along the crossing and the power thins
 * that peak into a filament.
 */
fn heroGlassCausticWeb(point: vec2f, seed: f32) -> f32 {
  var q = point;
  var amplitude = 1.0;
  var total = 0.0;
  var sum = 0.0;
  for (var i = 0u; i < CAUSTIC_OCTAVES; i++) {
    let phase = seed + f32(i) * 1.77;
    q += vec2f(sin(q.y * 1.31 + phase), cos(q.x * 1.17 - phase)) * 0.55;
    // Two families of folds crossing at an angle, unioned rather than added:
    // one family alone is a set of parallel streaks, and it is where they cross
    // and close that light on glass reads as folded rather than printed.
    let along = sin(q.x * 0.93 + q.y * 1.41 + phase * 0.7);
    let across = sin(q.x * -1.27 + q.y * 0.86 - phase * 1.3);
    sum += amplitude * max(
      pow(1.0 - abs(along), CAUSTIC_FILAMENT),
      pow(1.0 - abs(across), CAUSTIC_FILAMENT),
    );
    total += amplitude;
    q *= 1.93;
    amplitude *= 0.55;
  }
  let folds = clamp(sum / max(total, 0.0001), 0.0, 1.0);

  // The pool the folds sit in, which is what keeps them from reading as a
  // texture laid evenly over the whole triangle.
  let pool = 0.5 + 0.5 * sin(
    point.x * CAUSTIC_POOL_FREQUENCY * 0.62 +
    point.y * CAUSTIC_POOL_FREQUENCY * 0.41 +
    seed * 1.9
  ) * cos(
    point.y * CAUSTIC_POOL_FREQUENCY * 0.55 -
    point.x * CAUSTIC_POOL_FREQUENCY * 0.29 -
    seed * 1.1
  );
  return folds * (CAUSTIC_POOL_FLOOR + (1.0 - CAUSTIC_POOL_FLOOR) * pool);
}

/**
 * The caustic a fragment of the glass carries, masked to the flat of its face.
 *
 * `localPosition` and `localNormal` are the mesh's own coordinates; the normal
 * is the raw outward one, before any flip toward the camera, or the fragment
 * would be assigned to the face on the far side of the solid.
 */
export fn heroGlassFaceCaustic(localPosition: vec3f, localNormal: vec3f) -> f32 {
  let face = heroGlassFace(localPosition, normalize(localNormal));
  let flat = smoothstep(CAUSTIC_FLAT_FADE.x, CAUSTIC_FLAT_FADE.y, face.flatness);
  if (flat <= 0.0) { return 0.0; }

  // Each face gets its own turn, scale and phase, so the four read as four
  // surfaces rather than one texture wrapped round a shape.
  let seed = f32(face.index);
  let angle = seed * 1.21 + 0.37;
  let cosine = cos(angle);
  let sine = sin(angle);
  let turned = vec2f(
    face.uv.x * cosine - face.uv.y * sine,
    face.uv.x * sine + face.uv.y * cosine,
  );
  let scale = CAUSTIC_FREQUENCY * (1.0 + seed * 0.11);
  let web = heroGlassCausticWeb(
    turned * scale + vec2f(seed * 3.7, seed * -2.3),
    seed * 2.39,
  );

  let inset = smoothstep(CAUSTIC_EDGE_FADE.x, CAUSTIC_EDGE_FADE.y, face.edgeDistance);
  // Brightest in the band just inside an edge, where the fold is tightest.
  let rim = 1.0 + CAUSTIC_RIM_GAIN * (
    1.0 - smoothstep(CAUSTIC_EDGE_FADE.y, CAUSTIC_RIM_WIDTH, face.edgeDistance)
  );
  return web * flat * inset * rim;
}
