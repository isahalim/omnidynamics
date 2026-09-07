// Spectral light through the prism, drawn additively over the wall.
//
// This is vgpu's caustic pass reproduced in two dimensions. Theirs traces a
// 92,160-vertex spectral mesh — 128 wavelengths by 24 beam slices — through
// the glass and rasterises it. Ours solves the same refraction analytically in
// the wall plane, which is where the light lands and the only place the effect
// is seen. The values are its own: beam width 0.025, base IOR 1.2, Cauchy B
// 0.1, edge falloff 16, rainbow rate 3.8, rainbow power 3.7, strength 1.9,
// coverage 0.86, and a pointer that swings the beam between -35 and 75 degrees
// of incidence.
//
// Two wavelengths are traced, not 128: red and violet bound the fan, and every
// wavelength between them lands between their exit rays. A pixel's angle
// inside that wedge is therefore its wavelength, which turns a loop over the
// spectrum into a single lookup, and gives a continuous rainbow rather than
// 128 discrete slices.

const RED_NM = 680.0;
const VIOLET_NM = 400.0;
const PI = 3.14159265359;

/** Which span this draw is for: the light outside the glass, or inside it. */
const SEGMENT_EXTERIOR = 0.0;

struct Params {
  resolution: vec2f,
  prismCenter: vec2f,
  prismHalfExtent: vec2f,
  pointer: vec2f,
  beamWidth: f32,
  baseIor: f32,
  dispersion: f32,
  beamOpacity: f32,
  edgeFalloff: f32,
  rainbowRate: f32,
  rainbowPower: f32,
  strength: f32,
  coverage: f32,
  segment: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

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

/** The wavelength the beam's mean index is pinned to. */
const REFERENCE_NM = 540.0;

/**
 * Cauchy dispersion: n = A + B / lambda^2, with lambda in micrometres, which
 * is why violet bends further than red.
 *
 * Taken literally, vgpu's "Base IOR 1.2" and "Dispersion B 0.1" put violet at
 * n = 1.83 — past the critical angle at the exit face, so it never leaves the
 * glass and the fan collapses to white. Their B is in their own units. Here
 * the term is centred on `REFERENCE_NM` instead, so `baseIor` is the mean
 * index rather than the red end, and `dispersion` only sets the spread.
 */
fn indexOfRefraction(nanometres: f32) -> f32 {
  let micrometres = nanometres * 0.001;
  let reference = REFERENCE_NM * 0.001;
  return params.baseIor + params.dispersion * (
    1.0 / (micrometres * micrometres) - 1.0 / (reference * reference)
  );
}

struct Refraction {
  direction: vec2f,
  /** Zero when the ray was totally internally reflected. */
  transmitted: f32,
}

/**
 * 2D refraction, reporting total internal reflection rather than hiding it.
 *
 * The normal is re-oriented against the incident ray. Callers hand in the
 * face's outward normal, which faces the ray on the way in but away from it on
 * the way out; used as given on the way out it turns the refraction inside out
 * and sends the beam back through the glass.
 */
fn refract2(incident: vec2f, outward: vec2f, eta: f32) -> Refraction {
  var result: Refraction;
  let normal = select(outward, -outward, dot(outward, incident) > 0.0);
  let cosine = -dot(normal, incident);
  let k = 1.0 - eta * eta * (1.0 - cosine * cosine);
  if (k < 0.0) {
    result.direction = reflect(incident, normal);
    result.transmitted = 0.0;
    return result;
  }
  result.direction = eta * incident + (eta * cosine - sqrt(k)) * normal;
  result.transmitted = 1.0;
  return result;
}

/** Distance along `direction` to the segment a-b, or -1 when it misses. */
fn raySegment(origin: vec2f, direction: vec2f, a: vec2f, b: vec2f) -> f32 {
  let edge = b - a;
  let denominator = direction.x * edge.y - direction.y * edge.x;
  if (abs(denominator) < 1e-7) {
    return -1.0;
  }
  let delta = a - origin;
  let t = (delta.x * edge.y - delta.y * edge.x) / denominator;
  let u = (delta.x * direction.y - delta.y * direction.x) / denominator;
  if (t < 1e-5 || u < 0.0 || u > 1.0) {
    return -1.0;
  }
  return t;
}

/** Perpendicular pointing away from `interior`. */
fn outwardNormal(a: vec2f, b: vec2f, interior: vec2f) -> vec2f {
  let edge = normalize(b - a);
  let normal = vec2f(-edge.y, edge.x);
  let toInterior = interior - a;
  return select(normal, -normal, dot(normal, toInterior) > 0.0);
}

/**
 * Approximate CIE wavelength to linear RGB. Piecewise ramps rather than the
 * colour-matching functions: the fan is a glow, so hue placement matters and
 * spectral accuracy does not.
 */
fn spectralColor(nanometres: f32) -> vec3f {
  let w = clamp(nanometres, 380.0, 720.0);
  var rgb = vec3f(0.0);
  if (w < 440.0) {
    rgb = vec3f((440.0 - w) / 60.0, 0.0, 1.0);
  } else if (w < 490.0) {
    rgb = vec3f(0.0, (w - 440.0) / 50.0, 1.0);
  } else if (w < 510.0) {
    rgb = vec3f(0.0, 1.0, (510.0 - w) / 20.0);
  } else if (w < 580.0) {
    rgb = vec3f((w - 510.0) / 70.0, 1.0, 0.0);
  } else if (w < 645.0) {
    rgb = vec3f(1.0, (645.0 - w) / 65.0, 0.0);
  } else {
    rgb = vec3f(1.0, 0.0, 0.0);
  }
  // Roll the ends off so the fan fades out instead of ending on a hard edge.
  let ends = smoothstep(380.0, 420.0, w) * (1.0 - smoothstep(660.0, 720.0, w));
  return rgb * ends;
}

struct Trace {
  entry: vec2f,
  exit: vec2f,
  incoming: vec2f,
  direction: vec2f,
  valid: f32,
}

struct Entry {
  point: vec2f,
  normal: vec2f,
  incoming: vec2f,
}

/**
 * Where the beam meets the left face and which way it is heading.
 *
 * Wavelength-independent: the spectrum only parts on refraction, so every
 * wavelength shares this.
 */
fn beamEntry(apex: vec2f, left: vec2f, center: vec2f) -> Entry {
  var result: Entry;
  // Partway down the left face — high enough that the refracted ray crosses to
  // the right face with room to spare rather than grazing the corner it shares
  // with the base.
  result.point = mix(apex, left, 0.34);
  result.normal = outwardNormal(apex, left, center);

  // The pointer swings the angle of incidence: up-screen a shallow hit,
  // down-screen a steep one.
  //
  // The range is bounded by total internal reflection at the far face. For a
  // prism of apex angle A, a ray refracted to r1 on the way in meets the exit
  // face at A - r1, and our silhouette has A near 62 degrees — so a beam
  // arriving near the normal reaches the far face past the critical angle and
  // never leaves, which is what a literal reading of vgpu's -35..75 produced.
  // These two both transmit across the whole spectrum.
  let t = clamp(params.pointer.y * 0.5 + 0.5, 0.0, 1.0);
  let incidence = radians(mix(25.0, 65.0, t));
  let cosI = cos(incidence);
  let sinI = sin(incidence);
  let inward = -result.normal;
  result.incoming = normalize(vec2f(
    inward.x * cosI - inward.y * sinI,
    inward.x * sinI + inward.y * cosI,
  ));
  return result;
}

/** The direction one wavelength takes inside the glass. */
fn internalDirection(entry: Entry, n: f32) -> vec2f {
  return refract2(entry.incoming, entry.normal, 1.0 / max(n, 0.0001)).direction;
}

/**
 * Refracts one wavelength out through the given face.
 *
 * The face is chosen once by the caller, with a reference wavelength, rather
 * than per wavelength: the internal ray passes close to the corner between the
 * right face and the base, and a few nanometres either side is enough to flip
 * which one it reaches — which fanned the spectrum across two directions at
 * once instead of one.
 */
fn trace(
  nanometres: f32,
  entry: Entry,
  faceA: vec2f,
  faceB: vec2f,
  center: vec2f,
) -> Trace {
  var result: Trace;
  result.valid = 0.0;
  result.entry = entry.point;
  result.exit = entry.point;
  result.incoming = entry.incoming;
  result.direction = vec2f(1.0, 0.0);

  let n = indexOfRefraction(nanometres);
  let inside = internalDirection(entry, n);
  let distance = raySegment(entry.point, inside, faceA, faceB);
  if (distance <= 0.0) {
    return result;
  }

  let exit = entry.point + inside * distance;
  let outgoing = refract2(inside, outwardNormal(faceA, faceB, center), n);

  result.exit = exit;
  result.incoming = entry.incoming;
  result.direction = normalize(outgoing.direction);
  result.valid = outgoing.transmitted;
  return result;
}

/** Soft distance falloff across a beam of `width`. */
fn beamProfile(distance: f32, width: f32) -> f32 {
  let normalized = abs(distance) / max(width, 1e-5);
  return pow(clamp(1.0 - normalized, 0.0, 1.0), params.edgeFalloff * 0.25);
}

/** The incoming white beam, from off-screen to the entry point. */
fn incomingBeam(point: vec2f, entry: vec2f, direction: vec2f) -> f32 {
  let toPoint = point - entry;
  let along = dot(toPoint, direction);
  if (along > 0.0) {
    return 0.0;
  }
  let across = toPoint - direction * along;
  // Fades out the further back along the beam the pixel is, so it arrives from
  // the edge of the frame rather than starting abruptly.
  let reach = exp(along * 0.7);
  return beamProfile(length(across), params.beamWidth) * reach;
}

/** The span inside the glass, between the two refractions. */
fn internalSpan(point: vec2f, entry: vec2f, exit: vec2f) -> f32 {
  let edge = exit - entry;
  let lengthSquared = max(dot(edge, edge), 1e-6);
  let t = clamp(dot(point - entry, edge) / lengthSquared, 0.0, 1.0);
  let across = point - (entry + edge * t);
  return beamProfile(length(across), params.beamWidth * 1.4);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let uv = in.position.xy / max(params.resolution, vec2f(1.0));
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  let wallPoint = vec2f((uv.x - 0.5) * aspect, 0.5 - uv.y);
  // vgpu's beam arrives from the upper right and throws its spectrum left,
  // across the copy. The trace below is written left to right, so the whole
  // pass is evaluated mirrored about the prism's vertical axis — the
  // silhouette is symmetric about it, so the geometry maps onto itself.
  let point = vec2f(2.0 * params.prismCenter.x - wallPoint.x, wallPoint.y);

  let half = max(params.prismHalfExtent, vec2f(0.0001));
  let apex = params.prismCenter + vec2f(0.0, half.y);
  let left = params.prismCenter + vec2f(-half.x, -half.y);
  let right = params.prismCenter + vec2f(half.x, -half.y);

  let center = (apex + left + right) / 3.0;
  let entry = beamEntry(apex, left, center);

  // Whichever face the middle of the spectrum reaches first is the face the
  // whole spectrum leaves through.
  let reference = internalDirection(entry, indexOfRefraction(REFERENCE_NM));
  let toRight = raySegment(entry.point, reference, apex, right);
  let toBase = raySegment(entry.point, reference, left, right);
  var faceA = apex;
  var faceB = right;
  if (toBase > 0.0 && (toRight < 0.0 || toBase < toRight)) {
    faceA = left;
    faceB = right;
  }

  let red = trace(RED_NM, entry, faceA, faceB, center);
  let violet = trace(VIOLET_NM, entry, faceA, faceB, center);
  if (red.valid < 0.5 || violet.valid < 0.5) {
    return vec4f(0.0);
  }

  var light = vec3f(0.0);

  if (params.segment == SEGMENT_EXTERIOR) {
    // The white beam on its way in. Every wavelength shares it — they only
    // part on refraction — so red's trace is representative.
    light += vec3f(1.0) *
      incomingBeam(point, red.entry, red.incoming) *
      params.beamOpacity;

    // The outgoing fan. Red and violet bound it; the pixel's angle inside is
    // its wavelength.
    let origin = mix(red.exit, violet.exit, 0.5);
    let toPoint = point - origin;
    let reach = length(toPoint);
    if (reach > 1e-4) {
      let heading = toPoint / reach;
      let redAngle = atan2(red.direction.y, red.direction.x);
      let violetAngle = atan2(violet.direction.y, violet.direction.x);
      let pointAngle = atan2(heading.y, heading.x);
      let spread = violetAngle - redAngle;
      let span = max(abs(spread), 1e-4);
      let safeSpread = select(spread, span, abs(spread) < 1e-4);
      let position = (pointAngle - redAngle) / safeSpread;

      // Widen the wedge by the beam's own width so the fan has thickness where
      // it leaves the glass, and only resolves into colours further out.
      let angularWidth = params.beamWidth / max(reach, 1e-3);
      let padded = angularWidth / span;
      let mask = smoothstep(-padded, 0.0, position) *
        (1.0 - smoothstep(1.0, 1.0 + padded, position));
      if (mask > 0.0) {
        let nanometres = mix(RED_NM, VIOLET_NM, clamp(position, 0.0, 1.0));
        // Near the glass the wavelengths overlap and read as white; the colours
        // only separate once the fan is wider than the beam.
        let whiteness = clamp(padded, 0.0, 1.0);
        let hue = mix(spectralColor(nanometres), vec3f(1.0), whiteness);
        let falloff = pow(
          clamp(1.0 - reach * params.rainbowRate * 0.16, 0.0, 1.0),
          params.rainbowPower * 0.35,
        );
        light += hue * mask * falloff * params.coverage;
      }
    }
  } else {
    let nanometres = mix(RED_NM, VIOLET_NM, 0.5);
    light += mix(spectralColor(nanometres), vec3f(1.0), 0.7) *
      internalSpan(point, red.entry, red.exit) * params.beamOpacity;
  }

  return vec4f(light * params.strength, 1.0);
}
