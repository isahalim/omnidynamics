/** The column-major 4x4 operations the hero's placement and its rig need. */
import type { Quaternion, Vec3 } from "./constants";

/** `a` applied after `b`, both column-major. */
export function multiply4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * A model matrix that also turns the shape: yaw about Y, then pitch about X,
 * then roll about Z — the order a thing that banks into a turn reads in.
 *
 * The scale stays uniform, so the mesh shader's `model * vec4(normal, 0)` is
 * still a correct normal transform.
 */
export function spinModelMatrix(
  scale: number,
  translation: Vec3,
  yaw: number,
  pitch: number,
  roll = 0
): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  // Ry(yaw) * Rx(pitch), which is what this matrix was before roll joined it.
  const m = [
    [cy, sy * sx, sy * cx],
    [0, cx, -sx],
    [-sy, cy * sx, cy * cx],
  ];
  // ...then * Rz(roll), which mixes only the first two columns.
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    const [a, b, c] = m[row] as [number, number, number];
    out[row] = scale * (a * cz + b * sz);
    out[4 + row] = scale * (b * cz - a * sz);
    out[8 + row] = scale * c;
  }
  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

/**
 * A turn of `angle` about `axis`, taken through `pivot` rather than the origin:
 * the transform a hinge applies to the part hanging off it.
 */
export function rotationAbout(
  axis: readonly [number, number, number],
  angle: number,
  pivot: readonly [number, number, number]
): Float32Array {
  const length = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / length;
  const y = axis[1] / length;
  const z = axis[2] / length;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  // Rodrigues, written straight into the three basis columns.
  const out = new Float32Array(16);
  out[0] = t * x * x + c;
  out[1] = t * x * y + s * z;
  out[2] = t * x * z - s * y;
  out[4] = t * x * y - s * z;
  out[5] = t * y * y + c;
  out[6] = t * y * z + s * x;
  out[8] = t * x * z + s * y;
  out[9] = t * y * z - s * x;
  out[10] = t * z * z + c;
  // The pivot stays put: translate by it, less where the rotation sent it.
  for (let row = 0; row < 3; row++) {
    out[12 + row] =
      pivot[row]! -
      (out[row]! * pivot[0]! + out[4 + row]! * pivot[1]! + out[8 + row]! * pivot[2]!);
  }
  out[15] = 1;
  return out;
}

/**
 * A turn and a uniform scale taken about `pivot` rather than the origin: what
 * one key of a baked clip does to the part hanging off that joint.
 *
 * The scale is uniform because every clip these pages play states it that way,
 * which is what lets a key stay a quaternion and a number — and it leaves the
 * mesh shader's `pose * vec4(normal, 0)` pointing where it did, since a uniform
 * scale only lengthens a normal that is normalised again downstream.
 */
export function similarityAbout(
  rotation: Quaternion,
  scale: number,
  pivot: readonly [number, number, number]
): Float32Array {
  const [x, y, z, w] = rotation;
  const out = new Float32Array(16);
  out[0] = scale * (1 - 2 * (y * y + z * z));
  out[1] = scale * 2 * (x * y + z * w);
  out[2] = scale * 2 * (x * z - y * w);
  out[4] = scale * 2 * (x * y - z * w);
  out[5] = scale * (1 - 2 * (x * x + z * z));
  out[6] = scale * 2 * (y * z + x * w);
  out[8] = scale * 2 * (x * z + y * w);
  out[9] = scale * 2 * (y * z - x * w);
  out[10] = scale * (1 - 2 * (x * x + y * y));
  // The pivot stays put: translate by it, less where the turn sent it.
  for (let row = 0; row < 3; row++) {
    out[12 + row] =
      pivot[row]! -
      (out[row]! * pivot[0]! + out[4 + row]! * pivot[1]! + out[8 + row]! * pivot[2]!);
  }
  out[15] = 1;
  return out;
}

/**
 * Part of the way from one rotation to another, along the shorter arc.
 *
 * Both ends of a baked clip's key pair are close together, and so are the rest
 * position and any key it is faded toward, so the small-angle case is the one
 * that runs almost every time; the arc is only worth taking properly when the
 * two are far enough apart for a straight line between them to sag.
 */
export function slerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let end = b;
  if (cosine < 0) {
    cosine = -cosine;
    end = [-b[0], -b[1], -b[2], -b[3]];
  }
  let from = 1 - t;
  let to = t;
  if (cosine < 0.9995) {
    const angle = Math.acos(cosine);
    const sine = Math.sin(angle);
    from = Math.sin(from * angle) / sine;
    to = Math.sin(to * angle) / sine;
  }
  const out: Quaternion = [
    a[0] * from + end[0] * to,
    a[1] * from + end[1] * to,
    a[2] * from + end[2] * to,
    a[3] * from + end[3] * to,
  ];
  const length = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
  return [out[0] / length, out[1] / length, out[2] / length, out[3] / length];
}

export const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];

export const IDENTITY_4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/** `matrix` applied to a point, for the bounds the rig has to stay inside. */
export function transformPoint(
  matrix: Float32Array,
  point: readonly [number, number, number]
): [number, number, number] {
  return [0, 1, 2].map(
    (row) =>
      matrix[row]! * point[0] +
      matrix[4 + row]! * point[1] +
      matrix[8 + row]! * point[2] +
      matrix[12 + row]!
  ) as [number, number, number];
}
