/** The column-major 4x4 operations the hero's placement and its rig need. */
import type { Vec3 } from "./constants";

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
