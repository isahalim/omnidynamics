# The OmniDynamics house style

A design system written down so the next product looks like it came from the
same building. Every value here is lifted from the running site, not invented
for the document — if the site and this page disagree, the site is wrong and
should be brought back.

This file is deliberately self-contained and portable. Copy it into a new repo,
copy the two code blocks at the end into that repo's global stylesheet, and the
new thing is already in the family.

---

## 1. The idea, in one paragraph

**A wall with light falling on it, and objects standing on the wall.** That is
the whole conceit. The page is not a document with a background colour; it is a
room. Warm plaster catches window light from the upper right. Type is painted
directly onto the plaster — no cards behind it, no panels, no containers. The
only things that sit *on* the wall rather than *in* it are the controls, and
those are frosted glass: they refract the plaster behind them, they catch a
highlight on their top edge, and they cast a real shadow down onto it. One
physical object per page — a prism, a lens, some piece of glass — stands in the
frame and is the product, held inside the glass.

Everything else in this document is that paragraph, made specific.

**The three rules that generate the rest:**

1. **The wall is continuous.** Nothing paints its own background over it. A
   panel with an opaque fill is a hole cut in the room.
2. **Copy sits on the plaster; controls sit on the glass.** If it is a sentence,
   it is painted on. If you can press it, it is an object with a shadow.
3. **Hierarchy comes from opacity, not from a second colour.** One ink, stepped
   down. Colour is reserved for the two places it means something.

---

## 2. Colour

One warm neutral family, one near-black ink, one red. There is no second brand
colour, and adding one is the fastest way to stop looking like this.

```css
:root {
  --wall:      #d2ccc2;              /* lit plaster — the room's own colour */
  --wall-deep: #c9c2b7;              /* the same wall, further from the light */
  --on-wall:   #0a0a0a;              /* copy painted on plaster */
  --ink:       #16130f;              /* solid surfaces, emphasis, focus rings */
  --muted:     #6d6459;              /* the quiet step — warm grey, never blue */
  --accent:    #c0281d;              /* errors. Nothing else. */
  --line:      rgb(60 48 34 / 0.12); /* hairlines */
}
```

**Notes that matter:**

- `--muted` is a *warm* grey (a brown, really). A cool `#6b7280`-ish grey
  against this plaster reads as dirt. Every neutral in the system is mixed
  toward the wall.
- Shadows are never black. They are `rgb(60 48 34 / …)` — the wall's own
  shadow colour — so a lifted object looks lit rather than cut out.
- `--accent` appears exactly once in the live site: error text on the sign-in
  page. Keep it that scarce. A red that shows up in a marketing headline stops
  meaning "something went wrong".
- The green pip that marks a live session is `#2f7d4f`, hard-coded at its one
  use. It is a status light, not a palette entry.

### The wall itself

```css
body {
  background:
    radial-gradient(120% 90% at 78% -12%, #d8d3c9 0%, transparent 62%),
    linear-gradient(168deg, var(--wall) 0%, var(--wall-deep) 100%);
  background-attachment: fixed;
}
```

The radial is the window pool — light entering from the upper right, off-canvas.
The linear is the falloff across the room. `fixed` keeps the light source
stationary while the page scrolls, which is what a window does.

On this site a WebGPU canvas shades that same wall properly, with a cast shadow
and baked contact occlusion, and the CSS above is what stands in before it comes
up or where it cannot. **A product without the renderer uses the CSS wall alone
and is still on-style** — the gradient is the design, the shader is the luxury.
§12 has the files, the shaders and the budget if you want the real one.
Set `<meta name="theme-color" content="#d2ccc2">` so the browser chrome joins
the room.

### Light mode only, on purpose

There is no dark theme. The concept is a lit wall; a dark version is a different
room, not a variant. If a product genuinely needs one, it is a design project,
not a token swap — do not invert these values and ship it.

---

## 3. Type

Two families. A serif for the one big thing on the page, the system sans for
everything else. No webfont is loaded anywhere: the site downloads zero font
bytes, and that is a feature worth keeping.

```css
--font-display: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
--font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica,
           Arial, sans-serif;
```

### The scale

| Role | Size | Weight | Tracking | Leading |
|---|---|---|---|---|
| Display `h1` | `clamp(3rem, 9vw, 5.5rem)` | 400 serif | `-0.02em` | `0.9` |
| Display, hero page | `clamp(3.25rem, 11vw, 9.5rem)` | 400 serif | `-0.02em` | `0.86` |
| Lede | `clamp(1.15rem, 2.2vw, 1.5rem)` | **300** sans | `-0.015em` | `1.3` |
| Body | `1.0625rem` | 400 sans | — | `1.62` |
| Section head (`h2`) | `0.75rem` | 600 sans, uppercase | `0.12em` | — |
| Eyebrow / kicker | `0.6875rem` | 400 sans, uppercase | `0.12em` | — |
| UI / controls | `0.875rem` | 400 sans | — | — |
| Fine print | `0.8125rem` | 400 sans | — | `1.55` |

**The rules underneath the table:**

- **The serif is set at 400 and large.** It is never bold, never small, and
  never used for a paragraph. One per page, at the top. That single oversized
  light serif against small tight sans *is* the typographic signature.
- **Display type is tight and negative.** Line-height below 1 and
  `letter-spacing: -0.02em`. Headings set at 1.2 leading look like a blog.
- **The lede is weight 300.** Thin, large, one or two lines, often with a
  hand-placed `<br>` because the break is part of the composition.
- **Section headings are not big — they are small, uppercase and muted.** The
  size hierarchy inverts on purpose: the *label* recedes and the *content*
  carries. Nothing between the display serif and 1.0625rem body ever appears.
- **Measure is capped at `38rem` for body copy, `26–32rem` for notes.** Set it
  with `max-inline-size` on the paragraph, not on a wrapper.

**Long names need a cap keyed to their own length**, or an eleven-character
product name overruns the frame that a four-character one fit:

```css
h1 { font-size: clamp(3.25rem, min(11vw, calc(78vw / var(--chars, 6))), 9.5rem); }
```

…with `style={`--chars:${name.length}`}` on the element.

---

## 4. Layout

### The page shell

Every page is a viewport-tall flex column, positioned above the wall canvas:

```css
.page {
  position: relative;
  z-index: 2;                 /* the wall canvas sits at -1 */
  display: flex;
  flex-direction: column;
  min-block-size: 100dvh;
  padding: clamp(1rem, 2.5vw, 1.75rem)   /* top    */
           clamp(1.25rem, 4vw, 3.5rem)   /* inline */
           clamp(1.5rem, 4vh, 3rem);     /* bottom */
  color: var(--on-wall);
}
```

Use logical properties throughout (`inline-size`, `block-size`,
`margin-inline`, `padding-block-end`). The whole codebase does; mixing in
`width`/`height` reads as a patch.

### Measures, by page kind

| Page kind | `max-inline-size` |
|---|---|
| Landing / full-bleed composition | `88rem` |
| Account, dashboard | `52rem` |
| Prose (policy, docs) | `48rem` |
| A copy column inside a split | `27–34rem` |

### The split

The workhorse composition: **copy in a measured column, an object fitted
beside it.** Not a 50/50 grid — the object gets the larger share.

```css
.split {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  align-items: center;                 /* see the warning below */
  gap: clamp(1rem, 4vw, 3.5rem);
}
```

**`align-items: center` is wrong whenever the other column can grow after
paint.** An embed that sizes itself from the inside (a calendar, a chart, a
table that loads) will grow the row and drag the heading half a screen down the
moment it renders. On any page with late-arriving content, anchor to
`align-items: start` and let the columns be independent. This is the single
most common way to break the composition.

### The frame box — measured, never painted

The object beside the copy is drawn on the full-viewport canvas behind the page
(§12), **not** inside a container. The page contributes an empty, invisible box; the
renderer measures it and dollies the camera until the object fills that
rectangle. This is what keeps the wall continuous — there is no second surface
for the object to sit in.

```css
.stage {
  min-block-size: 60vh;       /* or a clamp, where the column must not stretch */
  touch-action: pinch-zoom;   /* a drag here aims the object; it is not a scroll */
}
```

`touch-action: pinch-zoom` on exactly that box, and nowhere else, is the rule:
the copy beside it must stay scrollable on a phone, and pinch stays alive
everywhere.

### Breakpoints

Four, and they are about the composition rather than about devices:

- **`60rem`** — the split collapses to one column; the object moves *above* the
  copy (`order: -1`) and drops to `min-block-size: 34vh`. Decorative side cards
  are dropped entirely rather than restacked.
- **`62rem`** — the same, one notch earlier, where the second column is an
  embed that needs more room.
- **`48rem`** — a full-bleed object stops being polite and takes the screen
  (`inline-size: 90vw`).
- **`30rem`** — header chrome sheds words: secondary links disappear, pill
  padding tightens, a name truncates to `7rem`.

**What is dropped is decoration; what survives is the way forward.** The demo
button is on the phone. The privacy link is not.

---

## 5. Material — the frosted glass

There is exactly one surface treatment, at three sizes. It is not a card style;
it is a piece of glass sitting in front of a lit wall, and every value in it is
doing that job: `saturate` pulls the wall's warmth through, the inset white line
is the light catching the top edge, and the long soft shadow is contact with the
wall behind.

```css
/* Small — a control group, a pill rail, a button frame */
.glass-sm {
  border-radius: 999px;
  background: rgb(255 255 255 / 0.5);
  backdrop-filter: blur(14px) saturate(170%);
  -webkit-backdrop-filter: blur(14px) saturate(170%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.9),
    0 1px 2px rgb(60 48 34 / 0.1),
    0 12px 28px -16px rgb(60 48 34 / 0.45);
}

/* Medium — a card, a definition list, a notice */
.glass-md {
  border-radius: 1.1rem;
  background: rgb(255 255 255 / 0.42);
  backdrop-filter: blur(16px) saturate(170%);
  -webkit-backdrop-filter: blur(16px) saturate(170%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.85),
    0 1px 2px rgb(60 48 34 / 0.08),
    0 16px 34px -22px rgb(60 48 34 / 0.55);
}

/* Large — a pane holding a third-party embed */
.glass-lg {
  border-radius: 1.4rem;
  padding: 0.6rem;                    /* the glass is a frame, not a container */
  background: rgb(255 255 255 / 0.5);
  backdrop-filter: blur(18px) saturate(170%);
  -webkit-backdrop-filter: blur(18px) saturate(170%);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.9),
    0 1px 2px rgb(60 48 34 / 0.1),
    0 30px 60px -34px rgb(60 48 34 / 0.6);
}
```

**The constants across all three:** `saturate(170%)`, an inset white top line,
a 1–2px contact shadow, and one long shadow with a large negative spread so it
pools under the object instead of haloing it. Bigger glass = more blur, lower
white, longer shadow.

**Borders are never used.** The inset highlight is the edge. A `1px solid`
border on this glass makes it a sticker.

**Hover raises the white**, it does not change the colour: `0.42 → 0.58`,
`0.5 → 0.7`.

### Framing a third-party embed

Third-party widgets draw their own opaque sheet. Give the glass a small padding
and the inner element the inner radius with `overflow: hidden`, so the borrowed
rectangle is inside the frame rather than sitting on it with square corners:

```css
.glass-lg > .embed { border-radius: 1rem; overflow: hidden; min-block-size: 0; }
```

Where the widget supports theming, hand it the site's ink as its brand colour
and force its light theme. A borrowed control should look like it was set into
the page, not dropped on it.

### Radii

`999px` for anything pill-shaped (rails, chips, buttons, the brand link's focus
ring) · `1.4rem` large pane · `1.1rem` card · `0.95rem` full-width inline button
· `1rem` inner embed · `0.35em` inline code.

### Inline code

```css
code {
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: 0.35em;
  background: rgb(60 48 34 / 0.08);
}
```

A warm wash of the wall's shadow colour — not a grey chip, and not a border.

---

## 6. Solid surfaces

Exactly one filled control exists: the primary action. It is **ink on the wall's
own colour**, which is the inverse of everything else on the page, and that is
why it reads as the one thing to press.

```css
.solid {
  color: var(--wall);
  background: var(--ink);
  box-shadow: 0 1px 2px rgb(60 48 34 / 0.2),
              0 8px 18px -10px rgb(20 18 15 / 0.8);
}
.solid:hover { background: #241f19; }   /* lighter, not darker: it is lit */
```

The same treatment marks a selected chip in a segmented rail. One solid element
per view. Two competing calls to action is the house style breaking.

---

## 7. Motion

Restrained, physical, and short. Nothing slides in, nothing fades up on scroll,
and there are no scroll-triggered reveals anywhere in the system.

```css
.clicky {
  transition: transform 0.14s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.22s ease,
              filter 0.22s ease;
}
.clicky:hover  { transform: translateY(-1.5px); }
.clicky:active { transform: translateY(0.5px) scale(0.985); }
.clicky:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; }

@media (prefers-reduced-motion: reduce) {
  .clicky, .clicky:hover, .clicky:active { transition: none; transform: none; }
}
```

Put `clicky` on **every** interactive surface — links included. The lift is the
same everywhere, which is what makes the page feel like one material.

**The durations, and what each is for:**

| Duration | Use |
|---|---|
| `0.14s` `cubic-bezier(0.22, 1, 0.36, 1)` | press and lift |
| `0.16s` same curve | an arrow nudging `2px` on hover |
| `0.2s ease` | colour and opacity on hover |
| `0.24s ease` | crossfading copy that is being replaced |
| `0.3s ease` | a status line appearing |
| `0.6–0.9s ease` | the wall fading up once the GPU is ready, once per load |

**The crossfade pattern**, for copy that swaps under a control: fade to 0, swap
the text at ~200ms, fade back. Never let text change while it is visible.

Every block above is repeated inside `prefers-reduced-motion: reduce` with
`transition: none`. That is not optional.

---

## 8. Hierarchy by opacity

There is no second text colour for "less important". There is one ink and a
ladder of opacities, and the ladder is consistent enough to be memorised:

| Opacity | Means |
|---|---|
| `1` | the current thing; a selected tab; emphasis |
| `0.85` | a hovered secondary item |
| `0.68–0.72` | a note, a lede, a resting nav link |
| `0.62` | a resting header link |
| `0.5` | an unselected tab |
| `0.35` | a separator dot |
| `0.28` | a rule |

Hover almost always means "go to 1". Use `var(--muted)` when the element is
genuinely a label (a `dt`, an eyebrow, fine print); use opacity when it is the
same content held back.

### The rule

A short hairline, not a full-width divider, and drawn in `currentColor` so it
belongs to the text above it:

```css
.rule {
  inline-size: min(100%, 22rem);   /* 18rem in a narrow column */
  block-size: 1px;
  margin-block: clamp(1.5rem, 4vh, 2.5rem);
  background: currentColor;
  opacity: 0.28;
}
```

It separates *movements* — after the lede, before the detail. Two or three per
page, never one per section.

---

## 9. Components

### The header

**Not a bar.** No background, no border, no sticky. Brand at the left, actions
at the right, sitting directly on the wall:

- **Brand** = mark + wordmark in one link. Mark at `30px` on interior pages,
  `42px` on the landing page. Wordmark `1rem`/500 inside, `clamp(1rem, 1.35vw,
  1.15rem)`/600 on the landing page. `border-radius: 999px` so the focus ring
  wraps the pair.
- **Actions** = one frosted pill rail (`.glass-sm`, `padding: 0.3rem`,
  `gap: 0.25rem`) containing a ghost link and the solid primary. Two links in
  one piece of glass read as one control; two bare links read as clutter.
- **Everything else** is plain muted text beside the rail, at `0.875rem`, and
  is the first thing dropped below `30rem`.

### The segmented rail

The same glass pill as the header actions, holding chips: transparent, `--muted`,
`min-inline-size: 5rem`, `padding: 0.6rem 1.05rem`. Selected takes the solid
treatment. Disabled is `opacity: 0.45` with `cursor: progress` — used while the
thing the rail controls is still loading, so a press cannot land before there is
anything to select.

### The card

`.glass-md`, `padding: 0.95rem 1.15rem`, a three-line grid with `gap: 0.15rem`:

```
kicker   0.6875rem, uppercase, 0.1em, --muted   ("Shipping", "Early access")
title    1rem, 600, -0.01em, --ink
sub      0.875rem, line-height 1.45, --muted
```

### Reserve the space a late element will need

Anything that arrives after paint — a third-party button, a name from a session,
an embed — gets its box up front, at its final height, with a quiet message in
it. Nothing below it may move when it lands.

```css
.door { display: grid; place-items: center; min-block-size: 3.25rem; }
.door > * { grid-area: 1 / 1; }   /* the message is replaced, not pushed */
```

Render the signed-in variant `hidden` in the HTML rather than absent, so the
space is already the right size.

### Third-party controls that must stay theirs

An identity provider's own button is drawn in their frame and must not be
restyled or reimplemented. Set it into a pane of the site's glass instead: the
frame is ours, the control is theirs, and the browser still vouches for it.
Measure the column and hand over a pixel width where the library demands one.

### Failure states are copy, not spinners

Every async surface has three states written as text: loading
(`Loading the calendar…`), failed (what went wrong, plus a human way through —
an email address), and not-configured (which env var to set). A silent empty
rectangle is the worst outcome in the system.

---

## 10. Voice

The visual style will not survive generic marketing copy. The writing is half of
the identity.

- **Say the mechanism, not the adjective.** "Pick a time and the invitation
  arrives with a Cal Video link on it" — not "seamless scheduling".
- **Plain words, complete sentences, an em dash where the thought turns.** No
  exclamation marks. No emoji anywhere in the product.
- **State limits out loud, in the place the decision is made**, not only in a
  policy nobody opens. One line under the sign-in button beats a paragraph on
  another page.
- **Every claim should be checkable against a file in the repo.** The privacy
  page is written next to the code it describes; the account page shows the
  actual values rather than the categories. A promise you can verify is worth
  more than a promise you can't.
- **Sentence case everywhere.** Uppercase is a typographic device for labels
  (`0.12em` tracked), never a way to shout.
- **Headings are two or three words.** "Welcome". "Book a demo". "Nothing
  here". The lede carries the sentence.
- **Code comments are prose, and they explain *why*.** This repo's comments
  say what a value is fighting — "the calendar arrives late and arrives *long*,
  so a centred alignment would drag the heading down the page". Keep that; it is
  what makes the system maintainable by someone who wasn't there.

---

## 11. Accessibility

Non-negotiable, and cheap at this scale:

- `:focus-visible` is a `2px solid var(--ink)` outline at `4px` offset — on
  everything, including the brand link. Never `outline: none`.
- `--on-wall` (`#0a0a0a`) on `--wall` (`#d2ccc2`) is ~15:1. Muted text on the
  wall is ~4.9:1. **Do not lighten `--muted`**; that is the value that is
  already near the floor.
- Decorative canvases and rules carry `aria-hidden="true"`; the object's
  clickable box is a real `<button>` with an `sr-only` label.
- Status lines are `role="status"` `aria-live="polite"`; errors are
  `role="alert"`.
- Selected chips use `aria-pressed`; a current tab uses `aria-current="page"`.
- `[hidden] { display: none !important; }` in the global sheet — components set
  `display` on those elements and the attribute would otherwise be ignored.
- Reduced motion is honoured in every block that animates.

---

## 12. The room in three dimensions — assets, shaders, and where they live

Everything above can be built with CSS alone. This section is the other half:
the actual files behind the lit plaster, the glass solid, the cast shadow and
the black orb, so the effect can be lifted rather than re-derived.

### What is actually being drawn

One `<canvas>`, fixed at `inset: 0`, `z-index: -1`, covering the viewport behind
the page. It is **the page's wall, not a picture hung on it** — the plaster the
shader lights is the same plaster the header sits on. The CSS gradient from §2
is underneath it and shows through only before the canvas fades up, and on
machines without WebGPU. Nothing between them paints a background, which is what
keeps the seam out.

```css
.wall {
  position: fixed; inset: 0; z-index: -1;
  inline-size: 100%; block-size: 100%;
  touch-action: none;
  opacity: 0; transition: opacity 0.9s ease;   /* 0.6s on interior pages */
}
.wall.ready { opacity: 1; }
```

### The dependency

| | |
|---|---|
| Package | [`vgpu`](https://www.npmjs.com/package/vgpu) `^0.4.0` + [`@vgpu/wgsl`](https://www.npmjs.com/package/@vgpu/wgsl) `^0.4.0` |
| Source | <https://github.com/vercel-labs/vgpu> · docs <https://vgpu.sh> |
| Licence | MIT (Vercel, Inc.) — the copy that must travel with the vendored code is `src/lib/glass/LICENSE` |
| Vendored example | vgpu's `glass-fractal`, in `src/lib/glass/` — see that directory's `README.md` for what was changed and why |
| Live tuning reference | <https://vgpu.sh/?debug> — where every light-mode number in `src/lib/prism/constants.ts` was read off |
| Build wiring | `wgslVitePlugin` from `@vgpu/wgsl/loader-vite`, in `astro.config.mjs` — resolves the `.wgsl` import graph and emits each shader as a linked module string |
| Agent skill | `.agents/skills/vgpu/SKILL.md`, pinned by `skills-lock.json` |

```bash
npx skills add vercel-labs/vgpu              # re-install the skill
npx -y add-mcp https://vgpu.sh/api/mcp -g    # add the docs MCP server
npm exec --no -- vgpu docs ls                # the docs for the *installed* version
npm exec --no -- vgpu docs find "<topic, symbol or error code>"
```

Treat the docs bundled with the installed package as the authority, not the
hosted ones — they track the version the code is written against.

### The binary assets

Everything served. Paths are relative to the site root; prefix them through
`withBase()` (`src/lib/base.ts`) so they resolve on both the apex domain and the
GitHub Pages mirror.

| Served path | Repo path | Size | What it is |
|---|---|---|---|
| `/glass/wall-material.png` | `public/glass/` | 816K | **The plaster texture.** 512², channel-packed: `r` = albedo variation, `g`/`b` = tangent-space normal XY, `a` = roughness. Two-octave tileable fbm plus ~220 tapered directional scratches. |
| `/prism/wall-global-light-mask.webp` | `public/prism/` | 16K | **The window.** vgpu's authored light mask; its `r` channel is the pool of window light falling on the wall. The only file the light pipeline fetches — if it fails, the bake falls back to vgpu's procedural window pools, so the wall is never flat. |
| `/glass/studio-cubemap-prefiltered.png` | `public/glass/` | 68K | **What the glass reflects.** A 3×2 cube cross with a prefiltered mip pyramid — the studio environment behind every highlight on the solid. |
| `/glass/rounded-tetrahedron.mesh` | `public/glass/` | 8K | **The glass solid itself**, in vgpu's HGP2 format. |
| `/glass/fractal-tetrahedron-l7.mesh` | `public/glass/` | 1.1M | vgpu's level-7 fractal geometry. **Held at full sphere morph, this is the orb.** |
| `/glass/models/chronovoxel.mesh` | `public/glass/models/` | 104K | The tesseract inside the glass |
| `/glass/models/drone.mesh` | `public/glass/models/` | 870K | |
| `/glass/models/robot.mesh` | `public/glass/models/` | 1.6M | |
| `/glass/models/manipulator.mesh` | `public/glass/models/` | 1.9M | |

**Not served** — sources and sidecars:

| Path | Size | What |
|---|---|---|
| `assets/models/dark_tesseract.glb` | 240K | Spline export, source for `chronovoxel.mesh` |
| `assets/models/drone.glb` | 1.1M | |
| `assets/models/nexbot_robot_character_concept.glb` | 2.8M | source for `robot.mesh` |
| `assets/models/robot_arm.glb` | 3.4M | source for `manipulator.mesh` |
| `src/lib/glass/model-rigs.json` | — | the joints read out of each GLB, for posing parts at runtime (`src/lib/prism/rig.ts`) |
| `src/lib/glass/model-clips.json` | — | authored animation, thinned to the keys the curve needs (the tesseract's nine nested shells) |

> **Licence check before you carry these across.** The vgpu code and its own
> assets are MIT. The GLB exports in `assets/models/` are third-party model
> assets and are *not* covered by that — confirm each one's terms before
> shipping it in another product.

### Baked on the GPU at start-up, not shipped

`src/lib/prism/assets.ts` bakes these on first frame, exactly as vgpu does. They
are the reason the asset list above is as short as it is:

| Bake | Size | Contents |
|---|---|---|
| Wall material | 512² | albedo / tangent-normal XY / roughness |
| Wall lighting | 512² | `r` the authored window mask, `g`/`b` the prism's contact shadow and ambient occlusion |
| Caustic profile | 1024×256 | distance × wavelength — the filaments inside the fan |
| Studio | 1024×512 | equirectangular HDR with a prefiltered mip pyramid |

### The shaders, by the effect they produce

All WGSL. `src/lib/prism/` is the light pipeline (ours, ported from vgpu's);
`src/lib/glass/` is the vendored glass-fractal example.

| Effect | Files |
|---|---|
| **Textured plaster wall** | `prism/wall.wgsl`, `wall-common.wgsl`, `wall-normal.wgsl`, `wall-presented.wgsl`, `bake-wall-material.wgsl` — plus `glass/hero-wall.wgsl`, the same shading ported into the glass example, and `glass/hero-fractal-background-draw.wgsl` which samples it |
| **Window glow / light pool** | `prism/bake-wall-lighting.wgsl`, `bake-common.wgsl`, with `/prism/wall-global-light-mask.webp` as the authored mask |
| **Cast shadow and contact occlusion** | `prism/shadow.wgsl`, `glass-grounding.wgsl`, `bake-wall-lighting.wgsl` (the `g`/`b` channels) |
| **The glass** | `glass/hero-glass.wgsl`, `hero-glass-transmission.wgsl`, `hero-glass-environment.wgsl`, `hero-glass-face-caustic.wgsl`; the prism variant is `prism/glass.wgsl`, `glass-back.wgsl`, `glass-common.wgsl`, `glass-accent.wgsl` |
| **The orb, and the shapes it morphs to** | `glass/hero-fractal-mesh.wgsl`, `hero-fractal-core.wgsl`, `hero-fractal-ceramic.wgsl`, `hero-fractal.wgsl`, `hero-fractal-sdf.wgsl`, `hero-fractal-present.wgsl` |
| **Light inside the glass** (the tesseract's lamp) | `glass/hero-core-light.wgsl` |
| **Caustic pooling inside the shadow** | `prism/hero-caustic.wgsl` — an analytic solve in the wall plane, two wavelengths rather than vgpu's 128 |
| **The full spectral beam** (coming-soon pages) | `prism/caustic.wgsl`, `spectral.wgsl`, `light-vertex.wgsl`, `beam-reveal.wgsl`, `optics.ts`, `light-mesh.ts`; the example's own is `glass/hero-prism-caustic.wgsl` |
| **Tone mapping and present** | `prism/tone-mapping.wgsl`, `present.wgsl`, `copy-linear.wgsl`, `color.wgsl` |

Composition of the two pipelines is `src/lib/prism/hero-renderer.ts`; the
interior registry — what is held inside the glass, and the morph between shapes
— is `src/lib/prism/interior.ts` with `src/lib/glass/models.ts`.

### The numbers that make it this room

All in `src/lib/prism/constants.ts` and `src/lib/glass/settings.ts`.

```js
PRISM_WALL_COLOR          = "#d2ccc2"   // identical to --wall. They must not drift.
PRISM_WALL_LIGHT_DIRECTION= [-0.48, 0.56, 0.68]   // to the key: up, left, out of the wall
PRISM_WALL_TUNING         = { normalStrength: 0.22, microNormalFrequency: 7,
                              microNormalStrength: 1.05, ambient: 0.5,
                              materialScale: 2.4 }
PYRAMID_SHADOW            = { opacity: 0.24, color: [0.04, 0.037, 0.033],
                              nearPenumbra: 0.05·edge, farPenumbra: 0.26·edge }
PYRAMID_CAUSTIC           = { color: [1, 0.965, 0.9], strength: 0.18, focus: 0.46 }
```

Two separate lights, and they are easy to confuse. `PRISM_WALL_LIGHT_DIRECTION`
is the vector *to* the key that rakes across the plaster's tooth — up, to the
left, and out of the wall toward the viewer — so it decides which side of every
scratch and bump catches. The broad pool of window light is not this: it is the
authored mask in `wall-global-light-mask.webp`, and it is what the CSS radial
in §2 stands in for.

The shadow is **warm and light** — `[0.04, 0.037, 0.033]` at 24% — because clear
glass does not stop light; most of what the silhouette covers arrives anyway,
just somewhere else. That is the same reasoning as the CSS
`rgb(60 48 34 / …)` shadows in §5: on this wall, nothing casts a neutral shadow.

**The glass** (`HERO_FRACTAL_GLASS`):

```js
ior: 1.149, reflectionStrength: 0.71, backOpacity: 0.19,
absorption: [74/255, 74/255, 74/255], frostRadius: 1.8,
dispersion: 0.025, iridescenceStrength: 0.04, iridescenceFrequency: 2,
environmentRotation: [0, -36, 0], sphereMix: 1   // the page opens on the orb
```

**Why the orb reads black.** Its material is nominally white:

```js
HERO_ORB_MATERIAL = { baseColor: [1,1,1], roughness: 0.25,
                      diffuseStrength: 0.08, specularStrength: 1.6,
                      ambientStrength: 0 }
```

There is no ambient term and almost no diffuse — so the body takes essentially
no fill light, and everything you see on it is the studio cubemap's specular
response at 1.6, seen through glass that absorbs at `74/255`. It is not a black
object; it is a white object lit only by its own highlights. That is worth
knowing before you try to "fix" it by darkening `baseColor`, which flattens it
instead. The fractal it morphs from is the dark ceramic
(`HERO_FRACTAL_MATERIAL`, `baseColor: [71/255, ...]`, `ambientStrength: 0.34`).

The one self-lit thing on the site is the core inside the tesseract:
`HERO_GLOW_MATERIAL = { color: [1, 0.965, 0.925], strength: 2.4 }` — white with
the room's warmth in it, because a light inside the glass that was neutral would
read as belonging to a different scene.

### Regenerating and checking

```bash
npm run check:shaders                      # device-backed validation, all 30 entries
                                           # (npm run build runs this first)
npx vgpu install-software-renderer         # CPU renderer — runners with no GPU; CI uses it
npm exec --no -- vgpu check <file.wgsl> --require-validation

node scripts/build-wall.mjs                # re-bake public/glass/wall-material.png
node scripts/check-wall-color.mjs          # then re-derive the linear WALL_COLOR constant
node scripts/build-meshes.mjs              # assets/models/*.glb → public/glass/models/*.mesh
node scripts/inspect-glb.mjs <file.glb>    # list a Spline export's nodes before converting
```

The renderer compiles its WGSL lazily in the browser, so a shader mistake
reaches the page as a **dead canvas rather than a build error**. That is what
`check-shaders` exists to prevent, and why it runs before `astro build` rather
than after. Committed mesh output is used directly by CI; the converters are not
part of the build.

### The mesh format

HGP2, vgpu's format — decoded by `decodeMesh` in
`src/lib/glass/hero-glass-assets-core.ts`, written by `scripts/build-meshes.mjs`:

```
header  40B : "HGP2", vertexCount u32, indexCount u32, stride u32 (24),
              meshMin f32x3, meshMax f32x3
vertex  24B : packed_position unorm16x4  xyz in [meshMin, meshMax], w = AO
              packed_normal   snorm16x4  w = rig part index / PART_SCALE
              packed_sphere   snorm16x4  xyz sphere target, w = orb AO
indices     : uint16   (so: 65,535 vertices max, and meshes are decimated to fit)
```

Every mesh carries a sphere morph target at **radius 0.4966** — the radius
vgpu's own fractal uses — which is what makes swapping one shape for another at
full morph invisible. A new model must be built to that radius or the swap
pops.

### Taking this to a new product: three tiers

**Tier 0 — CSS only.** The §2 gradient. Zero dependencies, zero assets, works
everywhere. An empty warm wall with good type is fully on-style; most products
should start here and stop here.

**Tier 1 — CSS wall plus glass controls.** Add the `.glass-*` recipes from §5.
Still zero assets.

> Do **not** reach for `wall-material.png` as a CSS `background-image`. It is a
> channel-packed data texture, not a picture — `g`/`b` are a normal map and `a`
> is roughness. Dropped into CSS it renders as coloured noise.

**Tier 2 — the full renderer.** Copy, in this order:

1. `src/lib/glass/` (the vendored example, **including `LICENSE`**) and
   `src/lib/prism/` (the light pipeline).
2. `public/glass/` and `public/prism/`.
3. `vgpu` and `@vgpu/wgsl` as dependencies; `wgslVitePlugin` in the bundler
   config; `check-shaders` first in the build script.
4. A component modelled on `src/components/LightPrism.astro` — the fixed canvas
   plus the `frame` selector that names the box the object is fitted into.

**Budget.** Wall, glass and the orb alone is ~2.0 MB of assets
(`wall-material.png` 816K + `fractal-tetrahedron-l7.mesh` 1.1M + cubemap 68K +
mask 16K + solid 8K). Every platform mesh you add is 100K–1.9M on top, fetched
lazily — the landing page prefetches them on `requestIdleCallback` *after* the
first shape is up, never before.

**Always ship the fallback.** Feature-detect and say so, keep the CSS wall
underneath, and never leave a silent empty canvas:

```js
if (!("gpu" in navigator)) say("This page needs WebGPU");
renderer.ready.then(
  () => canvas.classList.add("ready"),
  (error) => { say("The prism could not start"); console.error(error); }
);
```

---

## 13. Starting a new product

Copy these two blocks into the new project's global stylesheet. Everything above
is elaboration on them.

**The tokens and the room:**

```css
:root {
  --wall: #d2ccc2;
  --wall-deep: #c9c2b7;
  --on-wall: #0a0a0a;
  --ink: #16130f;
  --muted: #6d6459;
  --accent: #c0281d;
  --line: rgb(60 48 34 / 0.12);

  --font-display: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
  --font-ui: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica,
    Arial, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-block-size: 100dvh;
  color: var(--ink);
  font-family: var(--font-ui);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(120% 90% at 78% -12%, #d8d3c9 0%, transparent 62%),
    linear-gradient(168deg, var(--wall) 0%, var(--wall-deep) 100%);
  background-attachment: fixed;
}

img, svg { display: block; max-inline-size: 100%; }
```

**The one interaction primitive:**

```css
.clicky {
  transition: transform 0.14s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.22s ease, filter 0.22s ease;
}
.clicky:hover { transform: translateY(-1.5px); }
.clicky:active { transform: translateY(0.5px) scale(0.985); }
.clicky:focus-visible { outline: 2px solid var(--ink); outline-offset: 4px; }

@media (prefers-reduced-motion: reduce) {
  .clicky, .clicky:hover, .clicky:active { transition: none; transform: none; }
}
```

Then, in order:

1. Set `<meta name="theme-color" content="#d2ccc2">` and a manifest with
   `background_color` and `theme_color` to match, so the room extends into the
   browser chrome and the installed app.
2. Build the header: brand link, one frosted pill rail, one solid primary.
3. Give the page one display serif heading and one thin lede. Resist the second.
4. Decide the page's object — the thing that stands in the frame. If there is no
   renderer, the object can be a single well-made piece of glass or nothing at
   all; an empty warm wall with good type is on-style. A stock illustration is
   not. To bring the real renderer across, work from §12.
5. Add the rule, then the detail in 1.0625rem body at a 38rem measure.
6. Check it at `30rem`, `48rem` and `60rem`, at reduced motion, and with a
   keyboard only.

### The seven things that break the style

1. A second brand colour, or a cool grey.
2. An opaque panel behind copy — it cuts a hole in the wall.
3. A `1px solid` border on the glass.
4. A bold serif, or a serif below ~2.5rem.
5. Section headings that are larger than body text instead of smaller.
6. A loaded webfont.
7. A second solid button competing with the primary.

---

## 14. Where this lives in the repo

**The 2D system**

| Concern | File |
|---|---|
| Tokens, wall, `.clicky`, document head | `src/layouts/Base.astro` |
| The mark | `src/components/Logo.astro` |
| Header pill rail | `src/components/AccountActions.astro` |
| Landing composition, segmented rail | `src/components/Prism.astro` |
| Split composition (copy + object) | `src/pages/signin.astro`, `src/pages/soon/[state].astro` |
| Prose page | `src/pages/privacy.astro`, `src/pages/404.astro` |
| Glass framing a third-party embed | `src/pages/book.astro` |
| Manifest, icons, theme colour | `src/pages/site.webmanifest.ts`, `scripts/build-icons.mjs` |
| Base-path helper (apex vs. Pages mirror) | `src/lib/base.ts` |

**The renderer** — see §12 for the full breakdown

| Concern | File |
|---|---|
| Full-viewport wall + frame fitting | `src/components/LightPrism.astro` |
| Composition of the two pipelines | `src/lib/prism/hero-renderer.ts` |
| Every tunable number | `src/lib/prism/constants.ts`, `src/lib/glass/settings.ts` |
| GPU bakes (wall, lighting, caustic, studio) | `src/lib/prism/assets.ts` |
| What is held inside the glass | `src/lib/prism/interior.ts`, `src/lib/glass/models.ts` |
| Posing model parts | `src/lib/prism/rig.ts`, `src/lib/glass/model-rigs.json` |
| Light pipeline (ours) | `src/lib/prism/*.wgsl` |
| Vendored vgpu glass-fractal + its licence | `src/lib/glass/`, `src/lib/glass/README.md`, `src/lib/glass/LICENSE` |
| Served binary assets | `public/glass/`, `public/prism/` |
| Model sources | `assets/models/*.glb` |
| Asset pipeline | `scripts/build-wall.mjs`, `build-meshes.mjs`, `inspect-glb.mjs` |
| Checks | `scripts/check-shaders.mjs`, `check-wall-color.mjs` |
