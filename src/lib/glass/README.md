# Glass prism

Vendored from vgpu's `glass-fractal` example (vercel-labs/vgpu, MIT — see
`LICENSE`), with these changes:

- **`scene.ts`** — the single `fractal` draw became an `interiors` registry so
  the prism can hold any mesh. `registerInterior()` adds a model at runtime;
  `activeInterior` picks which one renders. Models draw with one instance;
  only vgpu's own fractal uses the four tetrahedral face instances. Each model
  also gets an `InteriorFit`: vgpu's fractal is authored in the tetrahedron's
  own frame, but the glass stands on the floor rather than sitting on the
  origin, so a mesh centred on its own bounds and scaled to fill the prism
  hangs out through the base. `createCameraControls` gained `focus` (pan) and
  `distanceScale` (dolly), which is how each page frames the prism now that
  the canvas is the whole viewport.
- **`renderer.ts`** — added `setState()`, which morphs the current shape out to
  the orb, swaps the interior mesh while every shape is the same sphere, then
  morphs the new one in, and `setFocus()`, which re-pans the camera when the
  layout stacks. The lil-gui tuning panel was removed.
- **`settings.ts`** — `sphereMix` defaults to 1 so the page opens on the orb.
- **`hero-fractal-background-draw.wgsl`** — the neutral studio backdrop became
  vgpu's beige wall, lit by a window pool anchored above the top-right corner.
- **`hero-glass-assets-core.ts`** — `decodeMesh` is exported so `models.ts` can
  decode the generated model meshes.

- **`hero-wall.wgsl`** (ours) — plaster shading ported from vgpu's
  `prism-background` wall pass, using the values its light pipeline exposes on
  <https://vgpu.sh/?debug>: wall colour `#d2ccc2`, normal strength 0.6, micro
  frequency 7, micro strength 1.05, ambient 0.5, light direction
  [-0.48, 0.56, 0.68]. The backdrop samples it in screen space (it reads as a
  head-on wall); the floor samples it in world space so perspective is right.

  The floor is shaded inside a ray-hit branch, and WGSL only allows
  `textureSample` from uniform control flow, so `shadeWall` takes explicit UV
  gradients and the caller computes them — along with the floor intersection —
  before the branch. Sampling implicitly there is a hard pipeline-compilation
  failure, not a visual glitch; `npm run check:shaders` catches it.

`models.ts` is ours: the state list, lazy mesh loading and prefetch.

The canvas is the page's wall. It covers the viewport behind the content on
every page that shows the prism, so the plaster the shader lights is the same
plaster the header and the picker sit on — a CSS imitation underneath it only
ever showed up as a seam where the two met.

## vgpu tooling

The `vgpu` skill is checked in at `.agents/skills/vgpu` (pinned by
`skills-lock.json`), and it says to treat the docs bundled with the installed
package as the authority for this project rather than the hosted ones. Read
them through the project-local binary, which is the version this code is
written against:

    npm exec --no -- vgpu docs ls
    npm exec --no -- vgpu docs find "<topic, symbol or error code>"
    npm exec --no -- vgpu check <file.wgsl> --require-validation

To re-install the skill, or add the docs MCP server:

    npx skills add vercel-labs/vgpu
    npx -y add-mcp https://vgpu.sh/api/mcp -g

## Checking the shaders

The renderer compiles its WGSL lazily in the browser, so a mistake reaches the
page as a dead canvas rather than a build error. `scripts/check-shaders.mjs`
runs vgpu's own device-backed validation over every entry ahead of that, and
`npm run build` runs it first.

    npm run check:shaders

Runners without a GPU need vgpu's portable CPU renderer first
(`npx vgpu install-software-renderer`); CI installs it.

## Regenerating the wall

`scripts/check-wall-color.mjs` derives the linear `WALL_COLOR` constant in
`hero-fractal-background-draw.wgsl` by inverting the shading chain over the
baked material, so re-baking the wall or changing the shading constants is
followed by re-reading the tint rather than guessing at it.

    node scripts/check-wall-color.mjs

`scripts/build-wall.mjs` bakes `public/glass/wall-material.png`
(r = albedo, gb = normal XY, a = roughness). The height field is vgpu's
two-octave plaster fbm made tileable — the lattice wraps and octaves double
exactly, rather than vgpu's 2.07 — plus a layer of tapered directional
scratches that cross the tile seam.

    node scripts/build-wall.mjs

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
