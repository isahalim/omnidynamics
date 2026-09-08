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

import { IDENTITY_4, multiply4, rotationAbout, spinModelMatrix } from "./matrix";
import { pyramidInteriorScaleReached } from "./pyramid";
import type { Vec2, Vec3 } from "./constants";

/** Must match `PART_SLOTS` in `../glass/hero-fractal-mesh.wgsl`. */
export const PART_SLOTS = 16;

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
  /**
   * A move it makes on the body's stride rather than on a clock of its own:
   * radians at the top of a pace, and which paces it is made on — 0 for every
   * other one from the first, 1 for the ones between, 2 for all of them. It
   * rises and falls inside the pace, so a leg that swings round on one pace is
   * back under the body in time to push on the next.
   */
  readonly pace?: readonly [number, number];
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
  /** The walk it takes itself round on, now and then. */
  readonly stride?: Stride;
}

/**
 * The stride a subject turns itself round on.
 *
 * A yaw laid over the whole subject is a turntable however smoothly it runs:
 * the feet slide, and nothing in the body accounts for the turn. So this yaw
 * does not run smoothly. It advances one pace at a time, stands on the spot
 * between them, and the joints that make each pace — the knee that lifts, the
 * leg that swings round to the new heading, the one that pushes against the
 * ground, the torso that leads and the arms that counterweight — are declared
 * against the same paces with `pace`.
 *
 * The circle is taken a piece at a time rather than in one sweep: each pace is
 * a step and then a stand, so the subject turns a little, looks at what is now
 * in front of it, and turns again. Over the whole walk it comes round a full
 * turn, which leaves it facing where it began with nothing to unwind.
 */
interface Stride {
  /** How far round it comes over the whole walk. */
  readonly turn: number;
  /** The period it comes round on, and the share of that the walk takes. */
  readonly period: number;
  readonly share: number;
  /** Where in the period it sets off. */
  readonly start: number;
  /** How many paces it takes to get round. */
  readonly paces: number;
  /** The share of each pace spent standing still at the end of it. */
  readonly hold: number;
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
 * somewhere it did not expect to be, and walks itself round on its own legs
 * working out how it got there.
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
    // its head at the room, spreads its hands at the question, shifts from one
    // foot to the other, and now and then walks itself round — an eighth of the
    // circle at a time, standing between each step to take in what is now in
    // front of it, until it has been the whole way round and found the same
    // glass everywhere. Every gesture comes round on a period that divides into
    // none of the others, so it never repeats the same beat twice running.
    body: {
      yaw: 0.3,
      pitch: 0.12,
      roll: 0.05,
      bob: [0.024, 1.8],
      sway: [0.02, 0.8],
      stride: {
        turn: -2 * Math.PI,
        period: 24,
        share: 0.6,
        start: 5.2,
        paces: 8,
        hold: 0.5,
      },
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
      // While it stands, the weight goes from one foot to the other and one
      // knee at a time gives under it. This is deliberately slighter than the
      // knee lift of a pace, because the two can fall together, and a stand
      // that borrows the whole lift of a step reads as a stumble.
      { part: "legLeft", axis: "x", idle: [0.09, 0.8, 0] },
      { part: "legRight", axis: "x", idle: [0.09, 0.8, 0] },
      { part: "shinLeft", axis: "x", episode: [-0.19, 5.6, 0.2, 1.0] },
      { part: "shinRight", axis: "x", episode: [0.19, 5.6, 0.2, 3.4] },
      // And the walk itself, a pace at a time, each an eighth of the circle.
      // The head looks where it is going and the torso follows it round, both
      // ahead of the hips; one knee lifts and that leg swings to the new
      // heading while the other pushes against the ground; the arms
      // counterweight the leg opposite them. Every one of them is back where
      // it started by the end of the step, so the stand that follows is a
      // stand rather than a pose held awkwardly.
      { part: "head", axis: "y", pace: [-0.34, 2] },
      { part: "torso", axis: "y", pace: [-0.28, 2] },
      { part: "legLeft", axis: "y", pace: [-0.32, 0] },
      { part: "legRight", axis: "y", pace: [-0.32, 1] },
      { part: "shinLeft", axis: "x", pace: [-0.44, 0] },
      { part: "shinRight", axis: "x", pace: [0.44, 1] },
      { part: "legLeft", axis: "x", pace: [0.14, 1] },
      { part: "legRight", axis: "x", pace: [0.14, 0] },
      { part: "armLeft", axis: "x", pace: [0.3, 1] },
      { part: "armRight", axis: "x", pace: [0.3, 0] },
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
      spec.body.stride !== undefined ||
      joints.some(
        ({ joint }) =>
          joint.spin !== undefined ||
          joint.idle !== undefined ||
          joint.episode !== undefined ||
          joint.pace !== undefined
      ));

  // A gesture whose period outruns the sweep is invisible to it, and the fit
  // would then be solved for poses the rig does not hold while holding one it
  // does. Walk far enough to see the slowest of them.
  const span = Math.max(
    CLOCK_SAMPLES * CLOCK_STEP,
    spec.body.stride?.period ?? 0,
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
          jointAngle(joint, spec.body.stride, pointer, time, reduceMotion) * amount,
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
            (spec.body.stride && !reduceMotion ? strideYaw(spec.body.stride, time) : 0)) *
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
  stride: Stride | undefined,
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
  const gesture = joint.episode ? episodeAngle(joint.episode, time) : 0;
  const walk = joint.pace && stride ? paceAngle(joint.pace, stride, time) : 0;
  return follow + spin + idle + gesture + walk;
}

/**
 * Which pace of a stride the clock is on and how far through it, or nothing at
 * all between one walk and the next.
 */
function stridePace(stride: Stride, time: number): readonly [number, number] | undefined {
  const window = stride.period * stride.share;
  const phase = (((time - stride.start) % stride.period) + stride.period) % stride.period;
  if (phase >= window) return undefined;
  const walked = (phase / window) * stride.paces;
  const index = Math.min(stride.paces - 1, Math.floor(walked));
  // A pace is a step and then a stand. Running the step out over the share of
  // the pace that is not the hold, and pinning it at its end through the rest,
  // leaves every joint exactly where the step put it while the subject stands.
  return [index, Math.min(1, (walked - index) / (1 - stride.hold))];
}

/**
 * How far round the subject has come: the paces behind it whole, and the one it
 * is in the middle of eased from end to end. The turn therefore moves while a
 * foot is in the air and stands still as it lands, which is the whole
 * difference between walking round and being turned round.
 */
function strideYaw(stride: Stride, time: number): number {
  const pace = stridePace(stride, time);
  if (!pace) return 0;
  const [index, through] = pace;
  return (stride.turn * (index + 0.5 * (1 - Math.cos(Math.PI * through)))) / stride.paces;
}

/**
 * A joint's part in the pace it is taken on: at rest at either end of it and
 * fully committed in the middle, so every limb is back under the body by the
 * time the foot lands and the next pace begins.
 *
 * The bump is a raised cosine rather than a half sine, which matters more than
 * it sounds. A half sine is at rest at both ends but is still travelling when
 * it gets there, so every limb arrives at the end of its pace at full speed and
 * stops dead — a step that lands like a dropped tool. This leaves and returns
 * with no speed at all.
 */
function paceAngle(
  [angle, on]: readonly [number, number],
  stride: Stride,
  time: number
): number {
  const pace = stridePace(stride, time);
  if (!pace) return 0;
  const [index, through] = pace;
  if (on < 2 && index % 2 !== on) return 0;
  return angle * 0.5 * (1 - Math.cos(2 * Math.PI * through));
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
 * reach both of its ends, and for every pace of the longest walk to have been
 * taken. That is a few hundred thousand corners for a rig with a dozen parts
 * and a walk to get through, so they are handed to the fit one at a time as
 * they are worked out rather than gathered into a list first: all it keeps of
 * them is how far the furthest reached toward each of the four faces.
 */
function poseFitScale(
  parts: readonly RigPart[],
  pose: (pointer: Vec2, time: number, settle: number) => RigPose,
  centre: Vec3,
  clockSamples: number
): number {
  const boxes = parts.map((part) => corners(part.min as Point, part.max as Point));
  return pyramidInteriorScaleReached((reach) => {
    for (let step = 0; step <= clockSamples; step++) {
      // A step that is no neat fraction of any of the periods in play, so the
      // fast spin and the slow sway are both walked through rather than caught
      // at one phase apiece.
      const time = step * CLOCK_STEP;
      for (let x = -POINTER_SAMPLES; x <= POINTER_SAMPLES; x++)
        for (let y = -POINTER_SAMPLES; y <= POINTER_SAMPLES; y++) {
          const posed = pose([x / POINTER_SAMPLES, y / POINTER_SAMPLES], time, 0);
          const lean = spinModelMatrix(1, posed.drift, posed.yaw, posed.pitch, posed.roll);
          for (let index = 0; index < boxes.length; index++) {
            // The two matrices a corner would go through are folded into one
            // per part rather than per corner, and the corners are then read
            // straight out of it.
            const placed = multiply4(lean, posed.parts[index] ?? IDENTITY_4);
            for (const [cx, cy, cz] of boxes[index]!)
              reach(
                placed[0]! * cx + placed[4]! * cy + placed[8]! * cz + placed[12]!,
                placed[1]! * cx + placed[5]! * cy + placed[9]! * cz + placed[13]!,
                placed[2]! * cx + placed[6]! * cy + placed[10]! * cz + placed[14]!
              );
          }
        }
    }
  }, centre);
}

function corners(min: Point, max: Point): Point[] {
  const out: Point[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]])
      for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}
