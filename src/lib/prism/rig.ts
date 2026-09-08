/**
 * What the platforms in the glass do, ported from the Spline scenes they came
 * from.
 *
 * Each of those scenes is more than a model on a turntable. The drone hangs off
 * a `Follow` group that leans it at a target while four `Rotation` hubs spin its
 * propellers; the arm is a `Base Y Rotation` with two hinges named for the axis
 * they swing on, tracking the same target; the humanoid turns its head and
 * swings its arms; the balloon dog leans on the two nested groups it is built
 * inside. `scripts/build-meshes.mjs` reads those joints out of the GLB and
 * stamps every vertex with the part it belongs to, leaving `model-rigs.json`
 * with each joint's pivot, its own axes, and how far its part reaches. This is
 * the other half: what angle each joint stands at, frame by frame.
 *
 * The one thing the scenes do not have to worry about, and this does, is the
 * glass. A model is fitted to the tetrahedron by its bounding box, so a part
 * that swings outside that box would push through a face. `sweptHalfExtents`
 * takes the box every joint can reach — through its whole range, and through
 * its parents' ranges above it — and the fit is solved against that instead, so
 * the shape stays inside the pyramid in every pose it can hold rather than only
 * in the one it was baked in.
 */
import rigTables from "../glass/model-rigs.json";

import {
  IDENTITY_4,
  multiply4,
  rotationAbout,
  spinModelMatrix,
  transformPoint,
} from "./matrix";
import { pyramidInteriorScalePoints } from "./pyramid";
import type { Vec2, Vec3 } from "./constants";

/** Must match `PART_SLOTS` in `../glass/hero-fractal-mesh.wgsl`. */
export const PART_SLOTS = 8;

interface RigPart {
  readonly name: string;
  /** The enclosing joint's part index; -1 for the subject itself. */
  readonly parent: number;
  readonly pivot: readonly number[];
  readonly axes: { readonly x: readonly number[]; readonly y: readonly number[]; readonly z: readonly number[] };
  readonly min: readonly number[];
  readonly max: readonly number[];
}

/**
 * One joint's motion, in the terms the Spline scenes state it in: a hub that
 * turns without stopping, a hinge that leans on the cursor, a limb that moves
 * whether or not anyone is watching.
 */
interface Joint {
  /** The part's name in `model-rigs.json`. */
  readonly part: string;
  /** Which of the part's own axes it turns about — the scene's own axis. */
  readonly axis: "x" | "y" | "z";
  /** Radians per second, for a hub that never stops. */
  readonly spin?: number;
  /** Radians per unit of cursor, across and down. */
  readonly follow?: readonly [number, number];
  /** Amplitude in radians, radians per second, and phase, for its own motion. */
  readonly idle?: readonly [number, number, number];
}

/** What the whole subject does, above and beyond its joints. */
interface Body {
  /** Radians per unit of cursor: yaw across, pitch down, roll across. */
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Rise and fall, in mesh units and radians per second. */
  readonly bob?: readonly [number, number];
  /** The same, sideways, a quarter out of step with the bob. */
  readonly sway?: readonly [number, number];
}

interface RigSpec {
  readonly body: Body;
  readonly joints: readonly Joint[];
}

/**
 * The four scenes, each keeping the character of its own.
 *
 * The drone banks into the cursor as its `Follow` group does, hovering on its
 * four rotors; the balloon dog leans the way its nested groups lean and turns
 * its head after the cursor; the arm plays its base against its two hinges, the
 * way a scene that tracks a target with three axes has to; the humanoid turns
 * its head first and lets its shoulders follow, arms swinging as it shifts.
 */
const RIGS: Readonly<Record<string, RigSpec>> = {
  drone: {
    body: { yaw: 0.5, pitch: 0.26, roll: 0.3, bob: [0.045, 1.6], sway: [0.02, 1.1] },
    joints: [
      // Diagonal pairs turn against each other, as a quadrotor's have to.
      { part: "rotor.0", axis: "y", spin: 26 },
      { part: "rotor.1", axis: "y", spin: -26 },
      { part: "rotor.2", axis: "y", spin: -26 },
      { part: "rotor.3", axis: "y", spin: 26 },
    ],
  },
  quadruped: {
    body: { yaw: 0.44, pitch: 0.2, roll: 0.16, bob: [0.022, 1.25], sway: [0.012, 0.85] },
    joints: [
      { part: "head", axis: "y", follow: [0.34, 0], idle: [0.05, 0.9, 0.4] },
      { part: "head", axis: "x", follow: [0, 0.26], idle: [0.04, 1.7, 1.1] },
    ],
  },
  manipulator: {
    // The pedestal is bolted to the floor: the arm does the moving, and the
    // shape itself only parallaxes a little under the cursor.
    body: { yaw: 0.2, pitch: 0.07, roll: 0 },
    joints: [
      { part: "base", axis: "y", follow: [0.46, 0], idle: [0.04, 0.42, 0] },
      { part: "shoulder", axis: "x", follow: [0, 0.24], idle: [0.05, 0.65, 1.9] },
      { part: "elbow", axis: "x", follow: [0, -0.3], idle: [0.07, 0.83, 0.6] },
    ],
  },
  robot: {
    body: { yaw: 0.3, pitch: 0.12, roll: 0.05, bob: [0.014, 1.05] },
    joints: [
      { part: "head", axis: "y", follow: [0.52, 0], idle: [0.03, 0.55, 0.2] },
      { part: "head", axis: "x", follow: [0, 0.3] },
      // The arms swing against each other, and reach a little after the cursor.
      { part: "armLeft", axis: "x", follow: [0, 0.12], idle: [0.11, 1.05, 0] },
      { part: "armRight", axis: "x", follow: [0, 0.12], idle: [0.11, 1.05, Math.PI] },
    ],
  },
};

export interface RigPose {
  /** One mesh-local matrix per shader slot; unused slots are the identity. */
  readonly parts: Float32Array[];
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** Added to where the shape stands, in mesh units. */
  readonly drift: Vec3;
}

export interface Rig {
  /** True when something moves without the cursor, so frames must keep coming. */
  readonly animated: boolean;
  /** The scale at which every pose it can hold still clears the glass. */
  fitScale(centre: Vec3): number;
  /**
   * Poses the rig. `settle` is how far the shape has morphed toward the orb:
   * at 1 every joint is back where it was baked, so the two shapes still meet
   * as the same sphere.
   */
  pose(pointer: Vec2, time: number, settle: number): RigPose;
}

/**
 * How finely the fit is sampled: the cursor on a 5x5 grid of its range, and the
 * clock at a step that is no neat fraction of a spin or an idle sway.
 */
const POINTER_SAMPLES = 2;
const CLOCK_SAMPLES = 24;
const CLOCK_STEP = 0.19;

/** A point the fit maths writes into, as against a `Vec3` it reads. */
type Point = [number, number, number];

/** The rig for a model interior, or undefined for a mesh that has none. */
export function rigFor(id: string, reduceMotion: boolean): Rig | undefined {
  const spec = RIGS[id];
  const parts = (rigTables as Record<string, RigPart[]>)[id];
  if (!spec || !parts) return undefined;

  // A joint naming a part the mesh does not carry is a build that has moved on
  // without this table; drop it rather than posing a slot that is not there.
  const joints = spec.joints
    .map((joint) => ({ joint, index: parts.findIndex((part) => part.name === joint.part) }))
    .filter((entry) => entry.index > 0);

  const animated =
    !reduceMotion &&
    (spec.body.bob !== undefined ||
      spec.body.sway !== undefined ||
      joints.some(({ joint }) => joint.spin !== undefined || joint.idle !== undefined));

  const rig: Rig = {
    animated,
    fitScale: (centre) => poseFitScale(parts, rig.pose, centre),
    pose(pointer, time, settle) {
      const amount = 1 - settle;
      const local: Float32Array[] = parts.map(() => IDENTITY_4);
      for (const { joint, index } of joints) {
        const part = parts[index]!;
        const turn = rotationAbout(
          axisOf(part, joint.axis),
          jointAngle(joint, pointer, time, reduceMotion) * amount,
          part.pivot as unknown as Vec3
        );
        // A joint that already carries a turn — the head's yaw and its pitch —
        // takes the second on top of the first.
        local[index] = local[index] === IDENTITY_4 ? turn : multiply4(local[index]!, turn);
      }

      // Down the chain, so a hinge rides on whatever its parent did.
      const posed: Float32Array[] = [];
      for (let index = 0; index < parts.length; index++) {
        const parent = parts[index]!.parent;
        posed[index] =
          parent >= 0 ? multiply4(posed[parent]!, local[index]!) : local[index]!;
      }
      while (posed.length < PART_SLOTS) posed.push(IDENTITY_4);

      const clock = reduceMotion ? 0 : time;
      const bob = spec.body.bob;
      const sway = spec.body.sway;
      return {
        parts: posed.slice(0, PART_SLOTS),
        yaw: -pointer[0] * spec.body.yaw * amount,
        pitch: -pointer[1] * spec.body.pitch * amount,
        roll: pointer[0] * spec.body.roll * amount,
        drift: [
          sway ? Math.sin(clock * sway[1]) * sway[0] * amount : 0,
          bob ? Math.sin(clock * bob[1]) * bob[0] * amount : 0,
          0,
        ],
      };
    },
  };
  return rig;
}

function axisOf(part: RigPart, axis: "x" | "y" | "z"): Vec3 {
  return part.axes[axis] as unknown as Vec3;
}

function jointAngle(
  joint: Joint,
  pointer: Vec2,
  time: number,
  reduceMotion: boolean
): number {
  const follow = joint.follow
    ? -pointer[0] * joint.follow[0] - pointer[1] * joint.follow[1]
    : 0;
  if (reduceMotion) return follow;
  const spin = joint.spin ? joint.spin * time : 0;
  const idle = joint.idle ? Math.sin(time * joint.idle[1] + joint.idle[2]) * joint.idle[0] : 0;
  return follow + spin + idle;
}

/**
 * The largest the posed shape can be drawn and still clear every face of the
 * glass.
 *
 * Rather than reason about the envelope in the abstract, this poses the rig
 * through a sweep of the cursor and the clock and measures what comes out: each
 * part's corners, carried through the very matrix that part will be drawn with,
 * and then through the subject's own lean and hover. The reach is taken toward
 * the four faces directly rather than through a bounding box, because a box
 * around a shape that leans grows in every direction at once — fitting to that
 * would halve the platform for a lean of a few degrees, while the shape itself
 * never came near a face.
 *
 * The samples cover the corners, edges and centre of the cursor's range, and
 * enough of the clock for a propeller to come round and for the slowest sway to
 * reach both of its ends.
 */
function poseFitScale(
  parts: readonly RigPart[],
  pose: (pointer: Vec2, time: number, settle: number) => RigPose,
  centre: Vec3
): number {
  const boxes = parts.map((part) => corners(part.min as Point, part.max as Point));
  const reached: Point[] = [];
  for (let step = 0; step <= CLOCK_SAMPLES; step++) {
    // A step that is no neat fraction of any of the periods in play, so the fast
    // spin and the slow sway are both walked through rather than caught at one
    // phase apiece.
    const time = step * CLOCK_STEP;
    for (let x = -POINTER_SAMPLES; x <= POINTER_SAMPLES; x++)
      for (let y = -POINTER_SAMPLES; y <= POINTER_SAMPLES; y++) {
        const posed = pose([x / POINTER_SAMPLES, y / POINTER_SAMPLES], time, 0);
        const lean = spinModelMatrix(1, posed.drift, posed.yaw, posed.pitch, posed.roll);
        for (let index = 0; index < boxes.length; index++)
          for (const corner of boxes[index]!)
            reached.push(
              transformPoint(lean, transformPoint(posed.parts[index] ?? IDENTITY_4, corner))
            );
      }
  }
  return pyramidInteriorScalePoints(reached, centre);
}

function corners(min: Point, max: Point): Point[] {
  const out: Point[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}
