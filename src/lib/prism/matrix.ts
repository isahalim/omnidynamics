/** The two column-major 4x4 operations the hero's placement needs. */
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
 * A model matrix that also turns the shape: yaw about Y, then pitch about X.
 *
 * The scale stays uniform, so the mesh shader's `model * vec4(normal, 0)` is
 * still a correct normal transform.
 */
export function spinModelMatrix(
  scale: number,
  translation: Vec3,
  yaw: number,
  pitch: number
): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  // Ry(yaw) * Rx(pitch), stored column-major and pre-scaled.
  return new Float32Array([
    scale * cy, 0, scale * -sy, 0,
    scale * sy * sx, scale * cx, scale * cy * sx, 0,
    scale * sy * cx, scale * -sx, scale * cy * cx, 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}
