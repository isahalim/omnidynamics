import { NodeIO } from "@gltf-transform/core";
import { KHRONOS_EXTENSIONS } from "@gltf-transform/extensions";
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  console.log(`\n=== ${f.split('/').pop()} ===`);
  const scene = doc.getRoot().listScenes()[0];
  const walk = (n, d) => {
    const m = n.getMesh();
    let verts = 0;
    if (m) for (const p of m.listPrimitives()) verts += p.getAttribute('POSITION')?.getCount() ?? 0;
    // subtree vert total
    let sub = verts;
    for (const c of n.listChildren()) sub += walk(c, d + 1);
    if (d >= 1 && d <= 2) console.log(`${'  '.repeat(d)}${n.getName()||'(unnamed)'}  [subtree ${sub} verts]`);
    return sub;
  };
  for (const r of scene.listChildren()) walk(r, 0);
}
