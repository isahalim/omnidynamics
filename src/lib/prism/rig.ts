/**
 * What the platforms in the glass do, ported from the Spline scenes they came
 * from.
 *
 * Each of those scenes is more than a model on a turntable. The drone hangs off
 * a `Follow` group that leans it at a target while four `Rotation` hubs spin its
 * propellers; the arm is a `Base Y Rotation` over hinges named for the axis they
 * swing on, down to a `Grab` with a jaw either side of it; the humanoid is built
 * of a head, two arms of shoulder, forearm and hand, and two legs of femur and
 * shin; the balloon dog leans on the two nested groups it is built inside.
 * `scripts/build-meshes.mjs` reads those joints out of the GLB and stamps every
 * vertex with the part it belongs to, leaving `model-rigs.json` with each
 * joint's pivot, its own axes, and how far its part reaches. This is the other
 * half: what angle each joint stands at, frame by frame.
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
export const PART_SLOTS = 12;

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
  /**
   * A move it only makes now and then: amplitude in radians, the period it
   * comes round on in seconds, the share of that period it spends making it,
   * and how far into the period it starts. A joint at rest outside its window
   * means several of them can take their turns one after another, which is
   * what separates a gesture from a sway.
   */
  readonly episode?: readonly [number, number, number, number];
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
  /**
   * A turn on the spot it makes now and then, stated the way a joint's
   * `episode` is: amplitude, period, the share of it spent turning, and where
   * in the period it starts. This is the subject turning to look behind
   * itself, rather than any one of its joints moving.
   */
  readonly turn?: readonly [number, number, number, number];
}

interface RigSpec {
  readonly body: Body;
  readonly joints: readonly Joint[];
}

/** The beat the arm reaches on, and the one the humanoid shrugs on. */
const REACH_RATE = 1.65;
const SHRUG_PERIOD = 5.2;

/**
 * The four scenes, each keeping the character of its own.
 *
 * The drone banks into the cursor as its `Follow` group does, hovering on its
 * four rotors; the balloon dog leans the way its nested groups lean and turns
 * its head after the cursor; the arm works its shoulder against its elbow so
 * the jaws travel up and down, closing on something at the bottom of each
 * reach and rolling the hand over now and then; the humanoid has been set down
 * somewhere it did not expect to be, and is working out how it got there.
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
      // Every so often it puts the whole arm somewhere else: a quarter turn
      // off its base and back again, the way one on a line swings between two
      // stations.
      { part: "base", axis: "y", follow: [0.46, 0], idle: [0.05, 0.6, 0], episode: [-Math.PI / 2, 6.2, 0.6, 2.1] },
      // Shoulder and elbow are a beat apart on one rhythm, so the jaws travel
      // up and down rather than swinging out, and the wrist keeps them level
      // through the reach.
      { part: "shoulder", axis: "x", follow: [0, 0.24], idle: [0.17, REACH_RATE, 1.9] },
      { part: "elbow", axis: "x", follow: [0, -0.3], idle: [0.24, REACH_RATE, 1.9 + Math.PI] },
      { part: "wrist", axis: "x", follow: [0, 0.1], idle: [0.11, REACH_RATE, 1.9] },
      // The jaws close at the bottom of each reach and open again at the top,
      // a quarter turn behind it, the way a hand closes on what it came for.
      { part: "jawLeft", axis: "x", idle: [0.09, REACH_RATE, 1.9 + Math.PI / 2] },
      { part: "jawRight", axis: "x", idle: [-0.09, REACH_RATE, 1.9 + Math.PI / 2] },
      // And now and then the whole hand rolls over on the axis it hangs from.
      { part: "grip", axis: "z", episode: [1.5, 5.1, 0.5, 0.9] },
    ],
  },
  robot: {
    // Set down somewhere it did not expect to be. It looks about itself, cocks
    // its head at the room, turns most of the way round to see what is behind
    // it and finds the same glass there, spreads its hands at the question, and
    // shifts from one foot to the other while it works out how it got here.
    // Every gesture comes round on a period that divides into none of the
    // others, so it never repeats the same beat twice running.
    body: {
      yaw: 0.3,
      pitch: 0.12,
      roll: 0.05,
      bob: [0.024, 1.8],
      sway: [0.02, 0.8],
      turn: [-2.4, 7.2, 0.5, 3.4],
    },
    joints: [
      { part: "head", axis: "y", follow: [0.52, 0], idle: [0.12, 1.2, 0.2], episode: [-0.85, 4.0, 0.38, 0.4] },
      { part: "head", axis: "x", follow: [0, 0.3], idle: [0.09, 1.7, 1.4] },
      // The tilt that asks the question.
      { part: "head", axis: "z", episode: [0.5, 3.4, 0.28, 2.6] },
      // The arms swing against each other, and reach a little after the cursor.
      { part: "armLeft", axis: "x", follow: [0, 0.12], idle: [0.2, 1.9, 0] },
      { part: "armRight", axis: "x", follow: [0, 0.12], idle: [0.2, 1.9, Math.PI] },
      { part: "forearmLeft", axis: "x", idle: [0.18, 1.9, 0] },
      { part: "forearmRight", axis: "x", idle: [0.18, 1.9, Math.PI] },
      // Then the shrug: both arms out at once, the forearms up after them, and
      // the hands turned palm up at the end of it — mirrored, so the signs run
      // opposite on the axes that are.
      { part: "armLeft", axis: "z", episode: [-0.46, SHRUG_PERIOD, 0.42, 3.1] },
      { part: "armRight", axis: "z", episode: [0.46, SHRUG_PERIOD, 0.42, 3.1] },
      { part: "forearmLeft", axis: "x", episode: [0.58, SHRUG_PERIOD, 0.42, 3.3] },
      { part: "forearmRight", axis: "x", episode: [-0.58, SHRUG_PERIOD, 0.42, 3.3] },
      { part: "handLeft", axis: "y", episode: [1.1, SHRUG_PERIOD, 0.38, 3.6] },
      { part: "handRight", axis: "y", episode: [-1.1, SHRUG_PERIOD, 0.38, 3.6] },
      // The weight goes from one foot to the other, and one knee at a time
      // gives under it.
      { part: "legLeft", axis: "x", idle: [0.09, 0.8, 0] },
      { part: "legRight", axis: "x", idle: [0.09, 0.8, 0] },
      { part: "shinLeft", axis: "x", episode: [-0.3, 5.6, 0.2, 1.0] },
      { part: "shinRight", axis: "x", episode: [0.3, 5.6, 0.2, 3.4] },
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
 * clock at a step that is no neat fraction of a spin or an idle sway, walked
 * far enough to catch the slowest gesture in the rig at least once.
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
      spec.body.turn !== undefined ||
      joints.some(
        ({ joint }) =>
          joint.spin !== undefined || joint.idle !== undefined || joint.episode !== undefined
      ));

  // A gesture whose period outruns the sweep is invisible to it, and the fit
  // would then be solved for poses the rig does not hold while holding one it
  // does. Walk far enough to see the slowest of them.
  const span = Math.max(
    CLOCK_SAMPLES * CLOCK_STEP,
    spec.body.turn?.[1] ?? 0,
    ...joints.map(({ joint }) => joint.episode?.[1] ?? 0)
  );
  const clockSamples = Math.ceil(span / CLOCK_STEP);

  const rig: Rig = {
    animated,
    fitScale: (centre) => poseFitScale(parts, rig.pose, centre, clockSamples),
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
        yaw:
          (-pointer[0] * spec.body.yaw +
            (spec.body.turn && !reduceMotion ? episodeAngle(spec.body.turn, time) : 0)) *
          amount,
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
  return follow + spin + idle + (joint.episode ? episodeAngle(joint.episode, time) : 0);
}

/**
 * Where a gesture stands at this moment: nowhere at all for most of its period,
 * and inside its window a raised cosine out to the far end and back.
 *
 * The cosine is what keeps it a gesture rather than a twitch — it leaves rest
 * and returns to it with no speed at either end, so a joint that spends most of
 * its life at zero never jumps as its turn comes round.
 */
function episodeAngle(
  [amplitude, period, share, start]: readonly [number, number, number, number],
  time: number
): number {
  const window = period * share;
  const phase = (((time - start) % period) + period) % period;
  if (phase >= window) return 0;
  return amplitude * 0.5 * (1 - Math.cos((2 * Math.PI * phase) / window));
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
 * enough of the clock for a propeller to come round, for the slowest sway to
 * reach both of its ends, and for every gesture to have had its turn.
 */
function poseFitScale(
  parts: readonly RigPart[],
  pose: (pointer: Vec2, time: number, settle: number) => RigPose,
  centre: Vec3,
  clockSamples: number
): number {
  const boxes = parts.map((part) => corners(part.min as Point, part.max as Point));
  const reached: Point[] = [];
  for (let step = 0; step <= clockSamples; step++) {
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
