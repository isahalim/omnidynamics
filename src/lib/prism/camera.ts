/**
 * vgpu's camera: fixed at `CAMERA_DISTANCE` on +Z looking at the origin, with a
 * few degrees of parallax under the pointer, plus the wall extent that follows
 * from its frustum meeting the z = 0 plane.
 */
import { perspectiveCamera } from "vgpu/scene";

import {
  CAMERA_DISTANCE,
  CAMERA_FOV_DEGREES,
  CAMERA_ORBIT_DEGREES,
  CAMERA_PITCH_DEGREES,
  CAMERA_YAW_DEGREES,
  type Vec2,
  type Vec3,
} from "./constants";

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Where a page's camera sits on its orbit, and how far the pointer swings it.
 * The light pipeline looks straight down its own axis; the landing page takes
 * the raised, slightly turned view vgpu frames its glass-fractal example at.
 */
export interface CameraOrientation {
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
  readonly orbitDegrees: number;
}

export const PRISM_ORIENTATION: CameraOrientation = {
  yawDegrees: CAMERA_YAW_DEGREES,
  pitchDegrees: CAMERA_PITCH_DEGREES,
  orbitDegrees: CAMERA_ORBIT_DEGREES,
};

export interface PrismView {
  readonly viewProjection: Float32Array;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

export function cameraView(
  aspect: number,
  orbitX = 0,
  orbitY = 0,
  distance = CAMERA_DISTANCE,
  fov = CAMERA_FOV_DEGREES,
  orientation: CameraOrientation = PRISM_ORIENTATION
): PrismView {
  const yaw = radians(orientation.yawDegrees + clamp(orbitX, -1, 1) * orientation.orbitDegrees);
  const pitch = radians(orientation.pitchDegrees - clamp(orbitY, -1, 1) * orientation.orbitDegrees);
  const cosPitch = Math.cos(pitch);
  const position: Vec3 = [
    Math.sin(yaw) * cosPitch * distance,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * cosPitch * distance,
  ];
  const forward = normalize([-position[0], -position[1], -position[2]]);
  const right = normalize(cross(forward, [0, 1, 0]));
  const camera = perspectiveCamera({
    fov,
    aspect,
    near: 0.05,
    far: 4 * distance,
    position,
    target: [0, 0, 0],
  });
  return {
    viewProjection: camera.viewProjectionMatrix as Float32Array,
    position,
    forward,
    right,
    up: cross(right, forward),
  };
}

/**
 * Half the wall's height in world units: the furthest the camera's frustum
 * corners reach on z = 0 across the whole parallax range, with 2% to spare so no
 * orbit can expose an edge.
 */
export function wallHalfHeight(
  aspect: number,
  distance = CAMERA_DISTANCE,
  fov = CAMERA_FOV_DEGREES,
  orientation: CameraOrientation = PRISM_ORIENTATION
): number {
  let reach = 0;
  for (const orbitX of [-1, 0, 1]) {
    for (const orbitY of [-1, 0, 1]) {
      const view = cameraView(aspect, orbitX, orbitY, distance, fov, orientation);
      const tangent = Math.tan(radians(fov) / 2);
      for (const x of [-1, 1]) {
        for (const y of [-1, 1]) {
          const ray: Vec3 = [0, 1, 2].map(
            (axis) =>
              view.forward[axis]! + view.right[axis]! * x * tangent * aspect + view.up[axis]! * y * tangent
          ) as unknown as Vec3;
          if (ray[2] >= 0) return Infinity;
          const t = -view.position[2] / ray[2];
          reach = Math.max(
            reach,
            Math.abs(view.position[0] + ray[0] * t) / aspect,
            Math.abs(view.position[1] + ray[1] * t)
          );
        }
      }
    }
  }
  return 1.02 * reach;
}

export function wallExtent(
  aspect: number,
  distance = CAMERA_DISTANCE,
  fov = CAMERA_FOV_DEGREES,
  orientation: CameraOrientation = PRISM_ORIENTATION
): Vec2 {
  const half = wallHalfHeight(aspect, distance, fov, orientation);
  return [half * aspect, half];
}

/** Column-major rotation matrix for XYZ Euler degrees, as the glass expects. */
export function rotationMatrix(degrees: Vec3): Float32Array {
  const [x, y, z] = degrees.map(radians);
  const [sx, cx] = [Math.sin(x!), Math.cos(x!)];
  const [sy, cy] = [Math.sin(y!), Math.cos(y!)];
  const [sz, cz] = [Math.sin(z!), Math.cos(z!)];
  return new Float32Array([
    cy * cz, cy * sz, -sy, 0,
    sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy, 0,
    cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy, 0,
    0, 0, 0, 1,
  ]);
}
