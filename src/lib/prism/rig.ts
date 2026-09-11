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
 * One subject states its own motion instead. The tesseract's nine shells each
 * turn and breathe on a curve nothing written here would be, so that curve is
 * read out of the GLB with the joints and played back from `model-clips.json`;
 * everything below still applies over the top of it.
 *
 * The one thing the scenes do not have to worry about, and this does, is the
 * glass. A model is fitted to the tetrahedron by its bounding box, so a part
 * that swings outside that box would push through a face. `sweptHalfExtents`
 * takes the box every joint can reach — through its whole range, and through
 * its parents' ranges above it — and the fit is solved against that instead, so
 * the shape stays inside the pyramid in every pose it can hold rather than only
 * in the one it was baked in.
 */
import modelClips from "../glass/model-clips.json";
import rigTables from "../glass/model-rigs.json";

import {
  IDENTITY_4,
  IDENTITY_QUATERNION,
  multiply4,
  rotationAbout,
  similarityAbout,
  slerp,
  spinModelMatrix,
} from "./matrix";
import { pyramidInteriorScaleReached } from "./pyramid";
import type { Quaternion, Vec2, Vec3 } from "./constants";

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
   * An angle it simply holds, before anything else moves it. This is posture
   * rather than motion — a head carried up, an arm floated away from the body —
   * so unlike everything else here it survives a reduced-motion setting, which
   * takes away movement and not the pose the subject is in.
   */
  readonly rest?: number;
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
   * Radians per second it turns about its own axis, without stopping. Nothing
   * in the body accounts for this, so it only suits a subject that is not
   * standing on anything — one adrift, which turns because nothing is holding
   * it still.
   */
  readonly spin?: number;
}

interface RigSpec {
  readonly body: Body;
  /**
   * The scene's own animation, for a subject that arrived with one. Every
   * joint it names is posed from the curve; the joints below still pose on top
   * of it, which is how a clip and a cursor can both have their say.
   */
  readonly clip?: string;
  readonly joints: readonly Joint[];
}

/**
 * One joint's baked curve, as `scripts/build-meshes.mjs` thins it: the key
 * times, the turn at each as a quaternion, and the uniform scale beside it.
 * Flat arrays rather than a list of keys, because this ships in the page's own
 * bundle and a key is five numbers and no structure.
 */
interface ClipTrack {
  readonly t: readonly number[];
  readonly q: readonly number[];
  readonly s: readonly number[];
}

interface Clip {
  /** Seconds. The curve returns to where it started, so it simply repeats. */
  readonly duration: number;
  readonly parts: Readonly<Record<string, ClipTrack>>;
}

/** The beat the arm reaches on. */
const REACH_RATE = 1.65;

/**
 * The four scenes, each keeping the character of its own.
 *
 * The drone banks into the cursor as its `Follow` group does, hovering on its
 * four rotors; the tesseract plays the turn and breath its own scene authored,
 * adrift under the cursor; the arm works its shoulder against its elbow so the
 * jaws travel up and down, closing on something at the bottom of each reach and
 * rolling the hand over now and then; the humanoid is adrift too, turning
 * slowly on its own axis with every limb loose in the current.
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
  chronovoxel: {
    // Nine shells folding through one another is all the motion the shape
    // needs, so nothing is laid over it but the drift of a thing with nothing
    // holding it still, and the lean it takes toward the cursor.
    body: {
      yaw: 0.4,
      pitch: 0.16,
      roll: 0.08,
      bob: [0.035, 0.5],
      sway: [0.018, 0.33],
    },
    clip: "chronovoxel",
    joints: [],
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
    // Adrift. It hangs in the glass the way a diver hangs in water: head
    // carried up and back, arms floated away from its sides, legs apart and
    // loosely bent under it because nothing is standing on them. Nothing here
    // is a gesture, and nothing comes round on a beat — every limb drifts on a
    // slow current of its own, at a rate that divides into none of the others,
    // so the pose never repeats and no two limbs ever arrive together.
    //
    // It turns about its own axis at a fifth of a degree a frame, which is slow
    // enough that you only notice it has come round if you look away and back.
    // A body that spins with nothing to push against is the one case where a
    // yaw laid over the whole subject is honest rather than a turntable.
    body: {
      yaw: 0.3,
      pitch: 0.12,
      roll: 0.05,
      spin: 0.07,
      bob: [0.06, 0.55],
      sway: [0.03, 0.37],
    },
    joints: [
      // The head is held up, and drifts about that.
      { part: "head", axis: "x", rest: -0.36, follow: [0, 0.3], idle: [0.05, 0.23, 0.5] },
      { part: "head", axis: "y", follow: [0.52, 0], idle: [0.09, 0.17, 1.9] },
      { part: "head", axis: "z", idle: [0.05, 0.29, 3.1] },
      // Everything above the waist turns and leans a little under it.
      { part: "torso", axis: "y", idle: [0.06, 0.19, 0.7] },
      { part: "torso", axis: "x", idle: [0.04, 0.13, 2.2] },
      // Mirrored parts take opposite angles, which is what makes a pair of them
      // symmetric — so the arms rest out to either side, and drift apart.
      { part: "armLeft", axis: "z", rest: -0.3, idle: [0.1, 0.21, 0] },
      { part: "armRight", axis: "z", rest: 0.3, idle: [-0.1, 0.21, 0] },
      { part: "armLeft", axis: "x", follow: [0, 0.12], idle: [0.09, 0.27, 1.1] },
      { part: "armRight", axis: "x", follow: [0, 0.12], idle: [-0.09, 0.25, 2.4] },
      { part: "forearmLeft", axis: "x", idle: [0.12, 0.31, 0.4] },
      { part: "forearmRight", axis: "x", idle: [-0.12, 0.29, 2.0] },
      // The hands turn over at the wrist, which is the loosest joint it has and
      // so the one that trails furthest behind the rest.
      { part: "handLeft", axis: "y", idle: [0.2, 0.37, 1.3] },
      { part: "handRight", axis: "y", idle: [-0.2, 0.35, 0.2] },
      // The legs hang apart, one a little ahead of the other, and trail from
      // the knee — which is what carries the feet, the rig having no ankle.
      { part: "legLeft", axis: "z", rest: -0.08, idle: [0.07, 0.15, 1.4] },
      { part: "legRight", axis: "z", rest: 0.08, idle: [-0.07, 0.16, 0.6] },
      { part: "legLeft", axis: "x", rest: 0.1, idle: [0.12, 0.22, 0.3] },
      { part: "legRight", axis: "x", rest: 0.1, idle: [0.12, 0.2, 2.6] },
      { part: "shinLeft", axis: "x", rest: -0.14, idle: [0.15, 0.26, 1.7] },
      { part: "shinRight", axis: "x", rest: 0.14, idle: [-0.15, 0.24, 0.5] },
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
 * clock walked far enough to see the slowest thing the rig does come round.
 *
 * `CLOCK_STEP` is the finest the clock is ever walked and no neat fraction of
 * any period in play, so a fast spin and a slow sway are both stepped through
 * rather than caught at one phase apiece. It also sets the shortest sweep, at
 * `CLOCK_SAMPLES_MIN` of it. A rig with a minute-long drift in it opens the
 * step up instead of running past `CLOCK_SAMPLES_MAX`, which keeps the whole
 * fit — every part's corners, in every pose, against every cursor — inside a
 * frame's worth of work.
 */
const POINTER_SAMPLES = 2;
const CLOCK_STEP = 0.19;
const CLOCK_SAMPLES_MIN = 24;
const CLOCK_SAMPLES_MAX = 160;

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

  const clip = spec.clip
    ? (modelClips as Record<string, Clip>)[spec.clip]
    : undefined;
  // The same, for the clip: only the parts it drives that the mesh still has.
  const played = clip
    ? Object.entries(clip.parts)
        .map(([name, track]) => ({
          track,
          index: parts.findIndex((part) => part.name === name),
        }))
        .filter((entry) => entry.index > 0)
    : [];

  const animated =
    !reduceMotion &&
    (played.length > 0 ||
      spec.body.bob !== undefined ||
      spec.body.sway !== undefined ||
      spec.body.spin !== undefined ||
      joints.some(
        ({ joint }) =>
          joint.spin !== undefined ||
          joint.idle !== undefined ||
          joint.episode !== undefined
      ));

  // Anything whose period outruns the sweep is invisible to it, and the fit
  // would then be solved over a sliver of the rig's motion while it spends the
  // rest of its time in poses nothing measured. So the sweep is stretched to
  // the slowest thing in the rig — a gesture states its period outright, and
  // anything turning at a rate comes round in a full turn of it — and the step
  // is opened up to match rather than adding samples without end, since a
  // motion that takes a minute needs no finer walking than one that takes four
  // seconds.
  const span = Math.max(
    CLOCK_SAMPLES_MIN * CLOCK_STEP,
    clip?.duration ?? 0,
    ...joints.map(({ joint }) => joint.episode?.[1] ?? 0),
    ...[
      spec.body.spin,
      spec.body.bob?.[1],
      spec.body.sway?.[1],
      ...joints.map(({ joint }) => joint.idle?.[1]),
    ].map((rate) => (rate ? (2 * Math.PI) / Math.abs(rate) : 0))
  );
  const clockSamples = Math.min(CLOCK_SAMPLES_MAX, Math.ceil(span / CLOCK_STEP));
  const clockStep = span / clockSamples;

  const rig: Rig = {
    animated,
    fitScale: (centre) => poseFitScale(parts, rig.pose, centre, clockSamples, clockStep),
    pose(pointer, time, settle) {
      const amount = 1 - settle;
      const local: Float32Array[] = parts.map(() => IDENTITY_4);
      // The scene's own curve first, so a joint written below still has the
      // last word over the part it shares with it. Both are faded out by the
      // morph, which is what leaves every shape the same sphere at the orb.
      if (clip) {
        const phase = reduceMotion ? 0 : ((time % clip.duration) + clip.duration) % clip.duration;
        for (const { track, index } of played) {
          const key = keyAt(track, phase);
          local[index] = similarityAbout(
            slerp(IDENTITY_QUATERNION, key.turn, amount),
            1 + (key.scale - 1) * amount,
            parts[index]!.pivot as unknown as Vec3
          );
        }
      }
      for (const { joint, index } of joints) {
        const part = parts[index]!;
        const turn = rotationAbout(
          axisOf(part, joint.axis),
          jointAngle(joint, pointer, time, reduceMotion) * amount,
          part.pivot as unknown as Vec3
        );
        // A joint that already carries a turn — the head's yaw and its pitch,
        // or a clip's key under either — takes the second on top of the first.
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
        yaw: (-pointer[0] * spec.body.yaw + (spec.body.spin ?? 0) * clock) * amount,
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

/**
 * Where a baked curve stands at this moment: the turn and the uniform scale,
 * interpolated between the two keys the time falls between.
 *
 * The keys are unevenly spaced — the thinning in `build-meshes.mjs` leaves them
 * where the curve bends and nowhere else — so the pair has to be searched for.
 * It is a walk rather than a bisection because the times are asked for in
 * order, both as the page plays and as the fit sweeps, so the pair wanted is
 * almost always at or just after the last one found.
 */
function keyAt(track: ClipTrack, time: number): { turn: Quaternion; scale: number } {
  const last = track.t.length - 1;
  let hi = 1;
  while (hi < last && track.t[hi]! < time) hi++;
  const lo = hi - 1;
  const start = track.t[lo]!;
  const progress = Math.min(
    1,
    Math.max(0, (time - start) / (track.t[hi]! - start || 1))
  );
  const at = (key: number): Quaternion => [
    track.q[key * 4]!,
    track.q[key * 4 + 1]!,
    track.q[key * 4 + 2]!,
    track.q[key * 4 + 3]!,
  ];
  return {
    turn: slerp(at(lo), at(hi), progress),
    scale: track.s[lo]! + (track.s[hi]! - track.s[lo]!) * progress,
  };
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
  const held = joint.rest ?? 0;
  if (reduceMotion) return held + follow;
  const spin = joint.spin ? joint.spin * time : 0;
  const idle = joint.idle ? Math.sin(time * joint.idle[1] + joint.idle[2]) * joint.idle[0] : 0;
  const gesture = joint.episode ? episodeAngle(joint.episode, time) : 0;
  return held + follow + spin + idle + gesture;
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
 * enough of the clock for a propeller to come round, for the slowest drift to
 * reach both of its ends, and for a subject turning on its own axis to have
 * come the whole way round. That is a few hundred thousand corners for a rig
 * with a dozen parts, so they are handed to the fit one at a time as they are
 * worked out rather than gathered into a list first: all it keeps of them is
 * how far the furthest reached toward each of the four faces.
 */
function poseFitScale(
  parts: readonly RigPart[],
  pose: (pointer: Vec2, time: number, settle: number) => RigPose,
  centre: Vec3,
  clockSamples: number,
  clockStep: number
): number {
  const boxes = parts.map((part) => corners(part.min as Point, part.max as Point));
  return pyramidInteriorScaleReached((reach) => {
    for (let step = 0; step <= clockSamples; step++) {
      const time = step * clockStep;
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
