# Glass prism

Vendored from vgpu's `glass-fractal` example (vercel-labs/vgpu, MIT — see
`LICENSE`), with these changes:

- **`scene.ts`** — the single `fractal` draw became an `interiors` registry so
  the prism can hold any mesh. `registerInterior()` adds a model at runtime;
  `activeInterior` picks which one renders. Models draw with one instance;
  only vgpu's own fractal uses the four tetrahedral face instances.
- **`renderer.ts`** — added `setState()`, which morphs the current shape out to
  the orb, swaps the interior mesh while every shape is the same sphere, then
  morphs the new one in. The lil-gui tuning panel was removed.
- **`settings.ts`** — `sphereMix` defaults to 1 so the page opens on the orb.
- **`hero-fractal-background-draw.wgsl`** — the studio backdrop is tinted warm
  to match the page's beige wall.
- **`hero-glass-assets-core.ts`** — `decodeMesh` is exported so `models.ts` can
  decode the generated model meshes.

`models.ts` is ours: the state list, lazy mesh loading and prefetch.

## Regenerating the model meshes

`scripts/build-meshes.mjs` converts the Spline GLB exports in `assets/models/`
into vgpu's HGP2 format at `public/glass/models/`. It keeps only the subject
node of each scene (the exports also ship wordmarks, floors and camera
targets — run `node scripts/inspect-glb.mjs <file.glb>` to list them),
decimates to fit the uint16 index space, bakes vertex occlusion, and writes a
sphere morph target at radius 0.4966 — the same radius vgpu's fractal uses, so
swapping meshes at full morph is invisible.

    node scripts/build-meshes.mjs

Committed output is used directly by CI; the converter is not part of the build.
