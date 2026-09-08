# Glass prism

Vendored from vgpu's `glass-fractal` example (vercel-labs/vgpu, MIT — see
`LICENSE`).

## Where it is used

The landing page is `src/lib/prism/hero-renderer.ts`, which composes two of
vgpu's examples: the light pipeline's lit wall, cast shadow and baked contact
occlusion (`src/lib/prism/`), with this example's glass standing on it — its
rounded tetrahedron, its screen-space transmission, its studio cubemap, its
20 degree camera raised off the axis, and its interior placement. From this
directory it uses:

- **`hero-glass.wgsl`**, **`hero-glass-transmission.wgsl`** — the glass itself.
  The transmission shader traces the tetrahedron against the four planes it is
  authored on. vgpu draws that solid at the origin, where mesh space and world
  space are the same; the landing page carries the same mesh into the frame its
  wall lives in, so the trace was moved into mesh space — `modelInverse` takes
  the ray there and `model` brings the sample point back. That is the only
  change to the material.
- **`hero-fractal-mesh.wgsl`** and its imports — the shape inside the glass,
  with vgpu's morph and its four tetrahedral face instances. One thing was
  added: `wholeMesh`, which is 1 for the model meshes the landing page holds and
  0 for the example's own geometry. vgpu's morph is authored for a single
  tetrahedron face — a tip-led stagger over the radius range that face's
  vertices span, travelling to a sphere target its own map produced — and a
  whole model mesh run through it shears into pieces on the way to the orb. A
  whole mesh morphs on one even progress instead, and along the ray its own
  sphere target lies on: `heroFractalWholeMeshMorph` interpolates the *log* of
  the radius, which keeps two points on a ray in order rather than letting a
  vertex inside the orb's radius cross one outside it and turn the surface
  inside out. Where those targets come from is
  `scripts/build-meshes.mjs`.

- **`hero-glass-face-caustic.wgsl`** (ours) — the light on the glass's own four
  faces. Each fragment is assigned to the face its normal points along, given a
  frame built from that face's edge, and carries a different piece of a folded
  light field at its own turn and scale; `hero-glass.wgsl` and
  `hero-glass-transmission.wgsl` screen it in. Without it the four faces are
  flat grey triangles and nothing on a face says which way it is turned.
- **`hero-glass-assets-core.ts`** — `decodeMesh` and `createStudioCubemap`;
  `hero-glass-assets.ts` adds the browser adapters that fetch them.
- **`settings.ts`** — vgpu's own glass and material controls, including where
  the interior sits inside the solid. `sphereMix` defaults to 1 so the page
  opens on the orb.

`models.ts` is ours: the state list and the model-mesh prefetch.

**`renderer.ts` and `scene.ts` are the example's own renderer, and nothing
mounts them now.** They were the landing page until it moved onto the wall
above; they are kept as the vendored example, along with the debug and
raymarched-fractal shaders only they reference.

## The rest of the vendored example

- **`hero-prism-caustic.wgsl`** (ours) — vgpu's caustic pass, written for the
  landing page's earlier glass. See below.

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

## The spectral beam

`hero-prism-caustic.wgsl` is vgpu's caustic pass as this example's renderer ran
it. The coming-soon pages draw the real thing — vgpu's own spectral light mesh,
in `src/lib/prism/` — and the landing page draws neither: it holds a platform in
the glass, and a rainbow across it would read as a second subject. What it draws
instead is `src/lib/prism/hero-caustic.wgsl`, the pool of light that comes
through clear glass and lands inside its own shadow.

vgpu traces a 92,160-vertex spectral mesh — 128 wavelengths by 24 beam slices —
through the glass and rasterises it. Ours solves the same refraction
analytically in the wall plane, which is where the light lands and the only
place the effect is seen. Two wavelengths are traced, not 128: red and violet
bound the fan and every wavelength between them arrives between their exit
rays, so a pixel's angle inside that wedge is its wavelength. That turns a loop
over the spectrum into one lookup and gives a continuous rainbow rather than
128 slices.

Three of vgpu's numbers do not survive the move and the shader says why at each
one: its beam width is in its own beam-space, its Cauchy B puts violet past the
critical angle so the fan collapses to white, and its -35..75 degree pointer
range spans total internal reflection at our apex angle.

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
