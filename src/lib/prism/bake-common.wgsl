// The generators behind vgpu's light-pipeline assets. Each bake entry is its
// own fullscreen pass; everything they share lives here.
import { spectralSample } from "./spectral.wgsl";

fn hash2(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn valueNoise(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (3.0 - 2.0 * local);
  let top = mix(hash2(cell), hash2(cell + vec2f(1.0, 0.0)), blend.x);
  let bottom = mix(
    hash2(cell + vec2f(0.0, 1.0)),
    hash2(cell + vec2f(1.0, 1.0)),
    blend.x,
  );
  return mix(top, bottom, blend.y);
}

export fn fbm(point: vec2f, octaves: u32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  var weight = 0.0;
  for (var octave = 0u; octave < octaves; octave++) {
    value += valueNoise(point * frequency) * amplitude;
    weight += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return value / weight;
}

export fn plasterHeight(uv: vec2f) -> f32 {
  return fbm(uv * 34.0, 5u) * 0.65 + fbm(uv * 117.0, 2u) * 0.35;
}

fn segmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let edge = end - start;
  let t = clamp(dot(point - start, edge) / max(dot(edge, edge), 1e-8), 0.0, 1.0);
  return distance(point, start + edge * t);
}

fn cross2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

fn triangleContains(point: vec2f, a: vec2f, b: vec2f, c: vec2f) -> bool {
  let ab = cross2(b - a, point - a);
  let bc = cross2(c - b, point - b);
  let ca = cross2(a - c, point - c);
  return (ab >= 0.0 && bc >= 0.0 && ca >= 0.0)
    || (ab <= 0.0 && bc <= 0.0 && ca <= 0.0);
}

/** The prism's baked contact shadow (x) and edge occlusion (y), in local units. */
export fn grounding(point: vec2f) -> vec2f {
  let apex = vec2f(0.0, -0.5773502692);
  let left = vec2f(-0.5, 0.2886751346);
  let right = vec2f(0.5, 0.2886751346);
  let base = segmentDistance(point, left, right);
  let baseContact = exp(-(base * base) / 0.00135);
  let edge = min(
    segmentDistance(point, apex, left),
    min(segmentDistance(point, left, right), segmentDistance(point, right, apex)),
  );
  let spread = select(0.014, 0.0015, triangleContains(point, apex, left, right));
  let edgeOcclusion = exp(-(edge * edge) / spread);
  return vec2f(
    clamp(1.0 - baseContact * 0.15, 0.0, 1.0),
    clamp(1.0 - edgeOcclusion * 0.075 - baseContact * 0.25, 0.0, 1.0),
  );
}

/** Stand-in window pools for when the authored mask cannot be loaded. */
export fn overheadLight(uv: vec2f) -> f32 {
  let upperLeft = exp(-dot((uv - vec2f(-0.08)) / vec2f(0.58, 0.64), (uv - vec2f(-0.08)) / vec2f(0.58, 0.64)) * 1.8) * 0.75;
  let center = exp(-dot((uv - vec2f(0.42, 0.22)) / vec2f(0.15, 0.17), (uv - vec2f(0.42, 0.22)) / vec2f(0.15, 0.17)) * 1.8) * 0.7;
  let right = exp(-dot((uv - vec2f(0.83, 0.3)) / vec2f(0.16, 0.18), (uv - vec2f(0.83, 0.3)) / vec2f(0.16, 0.18)) * 1.8) * 0.6;
  return clamp(upperLeft + center + right, 0.0, 1.0);
}

export fn beamColor(wavelength: f32) -> vec3f {
  let coordinate = clamp((wavelength - 400.0) / 300.0 * 127.0, 0.0, 127.0);
  let lower = min(u32(floor(coordinate)), 126u);
  return mix(spectralSample(lower).rgb, spectralSample(lower + 1u).rgb, fract(coordinate));
}
