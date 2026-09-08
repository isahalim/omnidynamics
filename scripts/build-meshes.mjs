/**
 * Converts the Spline GLB exports into vgpu's HGP2 mesh format so the glass
 * prism can render them with the same ceramic material and sphere morph it
 * uses for its own fractal.
 *
 * HGP2 layout (see src/lib/glass/hero-glass-assets-core.ts):
 *   header 40B  : "HGP2", vertexCount u32, indexCount u32, stride u32 (24),
 *                 meshMin f32x3, meshMax f32x3
 *   vertex 24B  : packed_position unorm16x4 (xyz in [meshMin,meshMax], w = AO)
 *                 packed_normal   snorm16x4 (w = rig part index / PART_SCALE)
 *                 packed_sphere   snorm16x4 (xyz sphere target, w = orb AO)
 *   indices     : uint16
 *
 * The rig is why `packed_normal.w` is no longer dead. Each Spline scene moves
 * its subject in parts — the drone's four rotors turn, the arm swings from its
 * base down to the jaws, the humanoid moves head, arms, hands and legs — and a
 * single baked mesh cannot express that. So the joints those scenes are built
 * around are read out of the GLB by name, every vertex is stamped with the part
 * it belongs to, and the parts table is written beside the mesh for the page to
 * pose at runtime.
 * See `src/lib/prism/rig.ts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, weld, simplify } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

// vgpu's own fractal puts every sphere-target vertex at this radius; matching it
// makes a geometry swap at full morph invisible.
const SPHERE_RADIUS = 0.4966;
// The spherical grid the morph target is equalised on, and the schedule of
// blur radii (in cells) it is equalised at. See `sphereDirections`.
const SPHERE_GRID = [192, 96];
const SPHERE_EQUALIZE = [
  { blur: 24, steps: 80, rate: 0.9 },
  { blur: 12, steps: 70, rate: 0.7 },
  { blur: 6, steps: 60, rate: 0.55 },
  { blur: 3, steps: 50, rate: 0.45 },
];
/**
 * The density a direction has to reach before it stops being pulled at, as a
 * share of the even cover.
 *
 * Flowing all the way to an even cover is the wrong target: it moves every
 * vertex, and these meshes arrive as hundreds of disconnected pieces, so a
 * subject that already closes into a sphere — the drone, the quadruped — comes
 * out shattered into fragments sliding over one another. Clamping the density
 * at this floor before the gradient is taken means a direction that is already
 * covered feels no pull at all, and only the neighbourhood of a bald patch
 * flows. Every mesh then moves as little as it has to.
 */
const SPHERE_DENSITY_FLOOR = 1.0;
const MAX_VERTICES = 65535; // uint16 index space
const AO_RAYS = 32;
const AO_GRID = 72;
const AO_MAX_STEPS = 26;

/**
 * The divisor the part index is stored under in `packed_normal.w`.
 *
 * snorm16 quantises to 1/32767, so an index over 64 round-trips exactly, and
 * the shader recovers it with a single multiply and round. It has to match
 * `PART_SCALE` in `hero-fractal-mesh.wgsl`.
 */
const PART_SCALE = 64;
const MAX_PARTS = 16; // PART_SLOTS in hero-fractal-mesh.wgsl

// Each Spline export also ships its presentation wordmark, a floor plane and a
// camera target. Those dominate the bounding box, so keep only the subject.
//
// `joints` names the nodes each Spline scene animates, in the order they become
// part indices — part 0 is always the rest of the subject. A node nested inside
// another joint takes the inner part, and the parts table records the nesting
// so a pose composes down the chain the way the scene's own hierarchy does.
const MODELS = [
  {
    id: "drone",
    src: "assets/models/drone.glb",
    keep: ["Follow"],
    radius: 1.0,
    yaw: 0,
    // Four `Wing > Rotation` hubs: the propellers, which the scene spins.
    joints: [{ node: "Rotation", as: "rotor" }],
  },
  {
    id: "quadruped",
    src: "assets/models/baloon_dog.glb",
    keep: ["Group 11"],
    radius: 0.98,
    yaw: 0.6,
    // The balloon dog's head, on the end of the nested lean groups.
    joints: [{ node: "Group 7", as: "head" }],
  },
  {
    id: "manipulator",
    src: "assets/models/robot_arm.glb",
    keep: ["Base Y Rotation", "Base"],
    radius: 1.0,
    yaw: -0.5,
    // The arm's own axes, named by the scene that drives them, down to the
    // wrist and the two jaws inside `Grab` that close on what it picks up.
    joints: [
      { node: "Base Y Rotation", as: "base" },
      { node: "1 Hand X rotation", as: "shoulder" },
      { node: "2 Hand X Rotation", as: "elbow" },
      { node: "3 Hand X Rotate", as: "wrist" },
      { node: "Grab", as: "grip" },
      { node: "Grab/1", as: "jawLeft" },
      { node: "Grab/2", as: "jawRight" },
    ],
  },
  {
    id: "robot",
    src: "assets/models/nexbot_robot_character_concept.glb",
    keep: ["Bot"],
    radius: 1.02,
    yaw: 0,
    // `Top part` is everything above the waist, so it is the joint the humanoid
    // twists on; each arm below it runs shoulder > forearm > hand, and each leg
    // under it femur > shin, so it can turn the way a body turns rather than
    // the way a turntable does. `Hand Instance`
    // is the mirrored left arm and `Hand` the right, as `Leg Left Instance` and
    // `Leg Left` are its legs; each is qualified by its parent, because the mesh
    // at the end of every forearm is also called "Hand".
    joints: [
      { node: "Bot/Top part", as: "torso" },
      { node: "Top part/Head", as: "head" },
      { node: "Top part/Hand Instance", as: "armLeft" },
      { node: "Top part/Hand", as: "armRight" },
      { node: "Hand Instance/Hand LEFT/arm/elbow/forearm", as: "forearmLeft" },
      { node: "Hand/Hand LEFT/arm/elbow/forearm", as: "forearmRight" },
      { node: "Hand Instance/Hand LEFT/arm/elbow/forearm/Hand", as: "handLeft" },
      { node: "Hand/Hand LEFT/arm/elbow/forearm/Hand", as: "handRight" },
      { node: "Leg Left Instance/femur", as: "legLeft" },
      { node: "Leg Left/femur", as: "legRight" },
      { node: "Leg Left Instance/femur/shin", as: "shinLeft" },
      { node: "Leg Left/femur/shin", as: "shinRight" },
    ],
  },
];

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const rigs = {};

for (const model of MODELS) {
  process.stdout.write(`\n${model.id}: `);
  const doc = await io.read(model.src);
  prune(doc, model.keep);
  // Before anything flattens the hierarchy: the joints are found by name in the
  // tree Spline authored, and every vertex is stamped with the part it is in.
  const joints = tagParts(doc, model.joints ?? []);

  await doc.transform(
    dedup(),
    flatten(),
    join({ keepNamed: false }),
    weld({ tolerance: 0.0001 })
  );

  let { positions, normals, indices, parts } = collect(doc);
  process.stdout.write(`${positions.length / 3} verts -> `);

  // meshopt honours its error bound over the ratio, so tighten in passes until
  // the mesh fits the uint16 index space rather than trusting a single ratio.
  await MeshoptSimplifier.ready;
  for (let error = 0.004; positions.length / 3 > MAX_VERTICES && error <= 0.5; error *= 2) {
    const ratio = (MAX_VERTICES * 0.9) / (positions.length / 3);
    await doc.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false })
    );
    ({ positions, normals, indices, parts } = collect(doc));
    process.stdout.write(`${positions.length / 3} -> `);
  }
  if (positions.length / 3 > MAX_VERTICES) {
    throw new Error(`${model.id}: ${positions.length / 3} verts exceeds uint16 index space`);
  }

  orient(positions, normals, model.yaw);
  const placement = normalize(positions, model.radius);
  // Spline bakes non-uniform scale into the node transforms, so the normals
  // arrive with arbitrary length; unit-length is required by both the occlusion
  // pass and the shader's fractal/sphere normal blend.
  if (!unitize(normals)) computeNormals(positions, indices, normals);

  const ao = occlusion(positions, normals, indices);
  const sphere = sphereDirections(positions);
  const out = encode(positions, normals, indices, ao, sphere, parts);
  rigs[model.id] = rigTable(joints, positions, parts, model.yaw, placement);

  mkdirSync("public/glass/models", { recursive: true });
  writeFileSync(`public/glass/models/${model.id}.mesh`, out);
  console.log(
    `${positions.length / 3} verts, ${indices.length / 3} tris, ` +
      `${(out.byteLength / 1024).toFixed(0)} KB, ` +
      `parts ${rigs[model.id].map((part) => `${part.name}:${part.count}`).join(" ")}`
  );
}

writeFileSync("src/lib/glass/model-rigs.json", `${JSON.stringify(rigs, null, 2)}\n`);
console.log("\nwrote src/lib/glass/model-rigs.json");

/**
 * Keeps only the named subject subtrees. Ancestors are retained so the world
 * transforms Spline baked into the hierarchy still apply.
 */
function prune(doc, keep) {
  const wanted = new Set(keep);
  const targets = [];
  const parents = new Map();
  const walk = (node) => {
    if (wanted.has(node.getName())) targets.push(node);
    for (const child of node.listChildren()) {
      parents.set(child, node);
      walk(child);
    }
  };
  for (const scene of doc.getRoot().listScenes())
    for (const root of scene.listChildren()) {
      parents.set(root, scene);
      walk(root);
    }

  if (targets.length !== wanted.size)
    throw new Error(`expected subjects [${keep.join(", ")}], matched ${targets.length}`);

  const survive = new Set();
  for (const target of targets) {
    const subtree = [target];
    while (subtree.length) {
      const node = subtree.pop();
      survive.add(node);
      subtree.push(...node.listChildren());
    }
    for (let a = parents.get(target); a; a = parents.get(a)) survive.add(a);
  }

  for (const [node, parent] of parents)
    if (!survive.has(node)) parent.removeChild(node);
}

/**
 * Finds the joints each Spline scene animates and stamps every vertex with the
 * part it belongs to, as a `_PART` attribute the rest of the pipeline carries.
 *
 * The tag has to be laid down here, before `flatten` and `join` dissolve the
 * hierarchy, because the hierarchy is the only record of which vertices belong
 * to a rotor rather than to the airframe. It survives the pipeline because
 * `weld` compares whole vertices — two vertices in different parts never merge —
 * and because `simplify` re-indexes attributes rather than interpolating them.
 *
 * A joint nested inside another takes the inner part, and its `parent` is the
 * enclosing joint, so the page can compose a pose down the same chain.
 */
function tagParts(doc, joints) {
  // Part 0 is the subject itself: everything no joint claims.
  const parts = [{ name: "body", parent: -1, node: undefined }];
  const path = [];

  const walk = (node, parent) => {
    path.push(node.getName());
    let part = parent;
    const joint = joints.find((candidate) => matchesPath(candidate.node, path));
    if (joint) {
      part = parts.length;
      parts.push({ name: joint.as, parent, node });
    }
    stampPart(doc, node, part);
    for (const child of node.listChildren()) walk(child, part);
    path.pop();
  };
  for (const scene of doc.getRoot().listScenes())
    for (const root of scene.listChildren()) walk(root, 0);

  // Several nodes can answer to one name — the drone's four `Rotation` hubs —
  // so a joint that matched more than once numbers its parts.
  const total = new Map();
  for (const part of parts) total.set(part.name, (total.get(part.name) ?? 0) + 1);
  const used = new Map();
  for (const part of parts) {
    if ((total.get(part.name) ?? 0) < 2) continue;
    const n = used.get(part.name) ?? 0;
    used.set(part.name, n + 1);
    part.name = `${part.name}.${n}`;
  }

  for (const joint of joints)
    if (!parts.some((part) => part.node && matchesPath(joint.node, nodePath(part.node))))
      throw new Error(`joint "${joint.node}" matched no node`);
  if (parts.length > MAX_PARTS)
    throw new Error(`${parts.length} parts exceeds the ${MAX_PARTS} the shader poses`);
  return parts;
}

/**
 * A joint selector is a trailing slice of a node's path — "Rotation" for any
 * node so named, "Top part/Hand" when a name alone is ambiguous, as it is for
 * the humanoid's arm and the mesh at the end of its forearm.
 */
function matchesPath(selector, path) {
  const wanted = selector.split("/");
  if (wanted.length > path.length) return false;
  return wanted.every((name, i) => name === path[path.length - wanted.length + i]);
}

function nodePath(node) {
  const path = [];
  for (let n = node; n && typeof n.getName === "function"; n = n.getParentNode?.())
    path.unshift(n.getName());
  return path;
}

/**
 * Writes one constant `_PART` value across a node's vertices.
 *
 * Spline instances share their mesh — the drone's four wings are one propeller
 * drawn four times, and the humanoid's two arms are one arm mirrored — so the
 * primitives are cloned per node first. The clone shares its position and normal
 * accessors, costing nothing but the tag itself, and gives each instance a
 * vertex range of its own to stamp.
 */
function stampPart(doc, node, part) {
  const mesh = node.getMesh();
  if (!mesh) return;
  const copy = doc.createMesh(mesh.getName());
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const values = new Float32Array(pos.getCount()).fill(part);
    copy.addPrimitive(
      prim
        .clone()
        .setAttribute("_PART", doc.createAccessor().setType("SCALAR").setArray(values))
    );
  }
  node.setMesh(copy);
}

/**
 * The parts table the page poses the mesh with: where each joint's axis sits in
 * the finished mesh's own coordinates, which way it turns, and how far the part
 * reaches — all after the same orientation and normalisation the vertices went
 * through, so the numbers are in the space the shader reads.
 *
 * The reach is a box rather than a radius because the page has to prove the
 * posed model still fits inside the glass, and a swept box is the thing
 * `pyramidInteriorScale` can be asked about.
 */
function rigTable(joints, P, parts, yaw, placement) {
  const bounds = joints.map(() => ({
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    count: 0,
  }));
  for (let i = 0; i < parts.length; i++) {
    const box = bounds[parts[i]] ?? bounds[0];
    box.count++;
    for (let a = 0; a < 3; a++) {
      box.min[a] = Math.min(box.min[a], P[i * 3 + a]);
      box.max[a] = Math.max(box.max[a], P[i * 3 + a]);
    }
  }

  return joints.map((joint, index) => {
    const box = bounds[index];
    const world = joint.node?.getWorldMatrix();
    // A joint's own axes, taken from the column vectors of its world matrix so
    // "spin about Y" means the propeller's Y, not the page's.
    const axis = (column) => {
      if (!world) return column === 1 ? [0, 1, 0] : column === 0 ? [1, 0, 0] : [0, 0, 1];
      const v = placeDirection(
        [world[column * 4], world[column * 4 + 1], world[column * 4 + 2]],
        yaw
      );
      const length = Math.hypot(v[0], v[1], v[2]) || 1;
      return v.map((value) => round(value / length));
    };
    return {
      name: joint.name,
      parent: joint.parent,
      count: box.count,
      pivot: world
        ? placePoint([world[12], world[13], world[14]], yaw, placement).map(round)
        : [0, 0, 0],
      axes: { x: axis(0), y: axis(1), z: axis(2) },
      min: box.count ? box.min.map(round) : [0, 0, 0],
      max: box.count ? box.max.map(round) : [0, 0, 0],
    };
  });
}

/** Five decimals: enough for a pivot, short enough to read in the JSON. */
function round(value) {
  return Math.round(value * 1e5) / 1e5;
}

/** A source-space point, through the same yaw and normalisation the mesh took. */
function placePoint(p, yaw, { centre, scale }) {
  const [x, y, z] = placeDirection(p, yaw);
  return [(x - centre[0]) * scale, (y - centre[1]) * scale, (z - centre[2]) * scale];
}

/** The yaw alone: a direction has no origin to be centred on or scaled about. */
function placeDirection([x, y, z], yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * x + s * z, y, -s * x + c * z];
}

/** Merges every primitive in the document into flat world-space arrays. */
function collect(doc) {
  const P = [], N = [], I = [], parts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const nrm = prim.getAttribute("NORMAL");
      const part = prim.getAttribute("_PART");
      const idx = prim.getIndices();
      const base = P.length / 3;
      for (let i = 0; i < pos.getCount(); i++) {
        parts.push(part ? Math.round(part.getScalar(i)) : 0);
        const p = pos.getElement(i, [0, 0, 0]);
        P.push(
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
        );
        const n = nrm ? nrm.getElement(i, [0, 0, 0]) : [0, 0, 0];
        N.push(
          m[0] * n[0] + m[4] * n[1] + m[8] * n[2],
          m[1] * n[0] + m[5] * n[1] + m[9] * n[2],
          m[2] * n[0] + m[6] * n[1] + m[10] * n[2]
        );
      }
      if (idx) for (let i = 0; i < idx.getCount(); i++) I.push(base + idx.getScalar(i));
      else for (let i = 0; i < pos.getCount(); i++) I.push(base + i);
    }
  }
  return { positions: P, normals: N, indices: I, parts };
}

/** Spline authors Y-up already; this only applies the per-model presentation yaw. */
function orient(P, N, yaw) {
  if (!yaw) return;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const A of [P, N]) {
    for (let i = 0; i < A.length; i += 3) {
      const x = A[i], z = A[i + 2];
      A[i] = c * x + s * z;
      A[i + 2] = -s * x + c * z;
    }
  }
}

/**
 * Centres on the bounding box and scales the bounding sphere to `radius`,
 * returning the placement so a joint's pivot can be carried through it too.
 */
function normalize(P, radius) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], P[i + a]);
      hi[a] = Math.max(hi[a], P[i + a]);
    }
  const c = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2);
  let maxR = 0;
  for (let i = 0; i < P.length; i += 3)
    maxR = Math.max(maxR, Math.hypot(P[i] - c[0], P[i + 1] - c[1], P[i + 2] - c[2]));
  const k = radius / (maxR || 1);
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) P[i + a] = (P[i + a] - c[a]) * k;
  return { centre: c, scale: k };
}

/** Normalises in place; returns false when the source normals are unusable. */
function unitize(N) {
  let degenerate = 0;
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l < 1e-9) { degenerate++; continue; }
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
  return degenerate < N.length / 30;
}

function computeNormals(P, I, N) {
  N.length = P.length;
  N.fill(0);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const n = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const o of [a, b, c]) for (let k = 0; k < 3; k++) N[o + k] += n[k];
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
  }
}

/**
 * Approximate ambient occlusion: voxelise the surface, then march a cosine-ish
 * ray fan around each vertex normal and count blocked directions. Cheap, and at
 * this scale indistinguishable from a baked solution once the ceramic shader
 * multiplies it into the diffuse term.
 */
function occlusion(P, N, I) {
  const g = AO_GRID;
  const grid = new Uint8Array(g * g * g);
  const at = (x, y, z) => (z * g + y) * g + x;
  const cell = (v) => Math.min(g - 1, Math.max(0, Math.floor(((v + 1.15) / 2.3) * g)));

  for (let t = 0; t < I.length; t += 3) {
    const p = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3].map((o) => [P[o], P[o + 1], P[o + 2]]);
    // Rasterise by sampling the triangle; dense enough for a 72^3 grid.
    for (let u = 0; u <= 4; u++)
      for (let v = 0; u + v <= 4; v++) {
        const w = 4 - u - v;
        const q = [0, 1, 2].map((a) => (p[0][a] * u + p[1][a] * v + p[2][a] * w) / 4);
        grid[at(cell(q[0]), cell(q[1]), cell(q[2]))] = 1;
      }
  }

  const dirs = fibonacci(AO_RAYS);
  const ao = new Float32Array(P.length / 3);
  const step = 2.3 / g;
  for (let i = 0; i < ao.length; i++) {
    const o = i * 3;
    const n = [N[o], N[o + 1], N[o + 2]];
    let blocked = 0, used = 0;
    for (const d of dirs) {
      const dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      if (dot <= 0.05) continue;
      used++;
      for (let s = 2; s <= AO_MAX_STEPS; s++) {
        const x = cell(P[o] + d[0] * step * s);
        const y = cell(P[o + 1] + d[1] * step * s);
        const z = cell(P[o + 2] + d[2] * step * s);
        if (grid[at(x, y, z)]) { blocked += 1 - (s - 2) / AO_MAX_STEPS; break; }
      }
    }
    // Match the fractal asset's 0.45..1.0 range so the material reads the same.
    ao[i] = 0.45 + 0.55 * (used ? Math.pow(1 - blocked / used, 1.6) : 1);
  }
  return ao;
}

function fibonacci(n) {
  const out = [], phi = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out.push([Math.cos(phi * i) * r, y, Math.sin(phi * i) * r]);
  }
  return out;
}

/**
 * Where each vertex goes when the shape becomes the orb.
 *
 * It used to be the vertex's own direction, taken to the orb's radius. For a
 * compact subject that is already a sphere — the drone's body and the
 * quadruped's cover nearly every direction out of their centre, so projecting
 * them outward closes into one. A robot arm does not: two fifths of the
 * directions around its centre have no surface in them at all, and the "orb" it
 * morphs into is a ribbon with a hole through it. That is what tore in the
 * transition, and why the swap to the real orb at the end of the morph — the
 * swap the whole transition is built on being invisible — popped.
 *
 * So the directions are spread until they cover the sphere evenly, and spread
 * by a field that is a smooth function of direction alone: the directions are
 * splatted into a spherical grid, the grid is blurred, and every direction
 * slides down the gradient of the log density, crowded directions pushing into
 * empty ones. Because one field moves every vertex, neighbours stay neighbours
 * — the surface stretches over the sphere instead of shredding across it — and
 * the blur is annealed from broad to fine so the far side of a bald patch is
 * felt before the last of the unevenness is smoothed out.
 */
function sphereDirections(P) {
  const [W, H] = SPHERE_GRID;
  const count = P.length / 3;
  const D = new Float64Array(P.length);
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    const length = Math.hypot(P[o], P[o + 1], P[o + 2]) || 1;
    D[o] = P[o] / length;
    D[o + 1] = P[o + 1] / length;
    D[o + 2] = P[o + 2] / length;
  }

  const cell = Math.PI / H;
  const density = new Float64Array(W * H);
  const blurred = new Float64Array(W * H);
  const scratch = new Float64Array(W * H);
  const floor = (SPHERE_DENSITY_FLOOR * count) / (4 * Math.PI);

  for (const pass of SPHERE_EQUALIZE) {
    const scale = pass.blur * cell;
    const step = pass.rate * scale * scale;
    const maxStep = 0.5 * scale;
    for (let iteration = 0; iteration < pass.steps; iteration++) {
      splat(D, density, W, H);
      blur(density, blurred, scratch, W, H, pass.blur);
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const [gradientTheta, gradientPhi] = logDensityGradient(
          D[o], D[o + 1], D[o + 2], blurred, W, H, floor
        );
        // Down the gradient: out of the crowd and into the empty directions.
        const theta = Math.acos(Math.max(-1, Math.min(1, D[o + 1])));
        const phi = Math.atan2(D[o + 2], D[o]);
        const sinTheta = Math.max(Math.sin(theta), 1e-3);
        let moveTheta = -step * gradientTheta;
        let movePhi = -step * gradientPhi / sinTheta;
        const move = Math.hypot(moveTheta, movePhi * sinTheta);
        if (move > maxStep) {
          moveTheta *= maxStep / move;
          movePhi *= maxStep / move;
        }
        const nextTheta = Math.max(1e-3, Math.min(Math.PI - 1e-3, theta + moveTheta));
        const nextPhi = phi + movePhi;
        D[o] = Math.sin(nextTheta) * Math.cos(nextPhi);
        D[o + 1] = Math.cos(nextTheta);
        D[o + 2] = Math.sin(nextTheta) * Math.sin(nextPhi);
      }
    }
  }
  return D;
}

/** Bilinear splat of the directions into the equirectangular grid. */
function splat(D, grid, W, H) {
  grid.fill(0);
  const cellPhi = (2 * Math.PI) / W;
  const cellTheta = Math.PI / H;
  for (let o = 0; o < D.length; o += 3) {
    const theta = Math.acos(Math.max(-1, Math.min(1, D[o + 1])));
    const phi = Math.atan2(D[o + 2], D[o]);
    const u = ((phi / (2 * Math.PI) + 1) % 1) * W - 0.5;
    const v = (theta / Math.PI) * H - 0.5;
    const u0 = Math.floor(u), v0 = Math.floor(v);
    const fu = u - u0, fv = v - v0;
    for (let dv = 0; dv <= 1; dv++)
      for (let du = 0; du <= 1; du++) {
        const y = v0 + dv;
        if (y < 0 || y >= H) continue;
        const x = ((u0 + du) % W + W) % W;
        grid[y * W + x] += (du ? fu : 1 - fu) * (dv ? fv : 1 - fv);
      }
  }
  // Per unit solid angle, so an even cover reads as an even density rather
  // than as a crowd at the poles.
  for (let y = 0; y < H; y++) {
    const area = Math.max(Math.sin(((y + 0.5) / H) * Math.PI), 1e-3) * cellPhi * cellTheta;
    for (let x = 0; x < W; x++) grid[y * W + x] /= area;
  }
}

/** Separable box blur, wrapping in longitude and clamping at the poles. */
function blur(source, target, scratch, W, H, radius) {
  const width = 2 * radius + 1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++)
        sum += source[y * W + (((x + d) % W) + W) % W];
      scratch[y * W + x] = sum / width;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++)
        sum += scratch[Math.max(0, Math.min(H - 1, y + d)) * W + x];
      target[y * W + x] = sum / width;
    }
}

/**
 * The gradient of log density at a direction, in (theta, phi), with the density
 * clamped from below so a well-covered direction reads as flat.
 */
function logDensityGradient(x, y, z, grid, W, H, floor) {
  const theta = Math.acos(Math.max(-1, Math.min(1, y)));
  const phi = Math.atan2(z, x);
  const u = ((phi / (2 * Math.PI) + 1) % 1) * W;
  const v = (theta / Math.PI) * H;
  const at = (du, dv) => {
    const gx = ((Math.floor(u + du) % W) + W) % W;
    const gy = Math.max(0, Math.min(H - 1, Math.floor(v + dv)));
    return Math.log(Math.max(grid[gy * W + gx], floor) + 1e-6);
  };
  return [
    ((at(0, 1) - at(0, -1)) / 2) * (H / Math.PI),
    ((at(1, 0) - at(-1, 0)) / 2) * (W / (2 * Math.PI)),
  ];
}

function encode(P, N, I, ao, sphere, parts) {
  const count = P.length / 3;
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], P[i + a]);
      hi[a] = Math.max(hi[a], P[i + a]);
    }
  const span = [0, 1, 2].map((a) => hi[a] - lo[a] || 1);

  const buf = new ArrayBuffer(40 + count * 24 + I.length * 2);
  const v = new DataView(buf);
  for (let i = 0; i < 4; i++) v.setUint8(i, "HGP2".charCodeAt(i));
  v.setUint32(4, count, true);
  v.setUint32(8, I.length, true);
  v.setUint32(12, 24, true);
  for (let a = 0; a < 3; a++) {
    v.setFloat32(16 + a * 4, lo[a], true);
    v.setFloat32(28 + a * 4, hi[a], true);
  }

  const un = (x) => Math.round(Math.min(1, Math.max(0, x)) * 65535);
  const sn = (x) => Math.round(Math.min(1, Math.max(-1, x)) * 32767);

  for (let i = 0; i < count; i++) {
    const o = 40 + i * 24, p = i * 3;
    for (let a = 0; a < 3; a++)
      v.setUint16(o + a * 2, un((P[p + a] - lo[a]) / span[a]), true);
    v.setUint16(o + 6, un(ao[i]), true);
    for (let a = 0; a < 3; a++) v.setInt16(o + 8 + a * 2, sn(N[p + a]), true);
    v.setInt16(o + 14, sn((parts?.[i] ?? 0) / PART_SCALE), true);
    for (let a = 0; a < 3; a++)
      v.setInt16(o + 16 + a * 2, sn(sphere[p + a] * SPHERE_RADIUS), true);
    v.setInt16(o + 22, sn(1), true); // orb state carries no occlusion
  }

  const indexOffset = 40 + count * 24;
  for (let i = 0; i < I.length; i++) v.setUint16(indexOffset + i * 2, I[i], true);
  return Buffer.from(buf);
}
