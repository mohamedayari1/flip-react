# flip-react — 3D PDF Flipbook (React + TypeScript)

Upload a PDF in the browser and read it as a book with a realistic **3D page-curl**: the
turning sheet bends around a virtual cylinder, a glossy highlight sweeps across it, and a
soft shadow pools in the fold. No WebGL, no `<canvas>` for the flip itself — just DOM
`<div>`s positioned with CSS `matrix3d`.

This is a from-scratch React/TypeScript port of [`ts1/flipbook-vue`](https://github.com/ts1/flipbook-vue)
(MIT, © Takeshi Sone). The Vue framework code was rewritten in React idiom; the only reused
dependency is `rematrix`, a framework-agnostic matrix-math library.

```bash
bun install
bun run dev      # http://localhost:5173 — upload a PDF and flip
bun run test     # vitest: the math core
bun run build    # production bundle
```

---

## How the effect works (the 30-second version)

A page that is turning is sliced into **N vertical strips** (default 10). Each strip is a
`<div>` showing one slice of the page image. We bend the flat strips around an imaginary
**cylinder** by giving each one its own `matrix3d` transform:

```
strip i sits at angle `rad` around a cylinder of radius r:
    x = sin(rad) · r        →  how far across the spread
    z = (1 - cos(rad)) · r  →  how far it lifts toward the viewer
matrix = pageMatrix · translate3d(x, 0, z) · rotateY(-tilt)
```

The cylinder's wrap angle `theta` grows from ~0 (flat) at the start of the flip to a
maximum mid-flip, then back to ~0 — so paper is **flat at rest and most curled in the
middle of a turn**, just like the real thing. On top of the geometry, each strip gets a
CSS gradient overlay: a black **ambient shadow** that deepens as the strip turns away, and
a thin white **specular gloss** whose peak slides across the page as it moves.

The animation is driven by a `requestAnimationFrame` loop over `progress` (0→1); the strip
matrices are **recomputed in JS every frame**. (CSS-transitioning `matrix3d` would
interpolate the matrices wrongly and destroy the curl — see the note in `Flipbook.tsx`.)

For the full derivation with diagrams, read the header of **`src/flipbook/geometry.ts`** —
that file is the heart of the effect and is heavily documented.

---

## Architecture / file map

```
src/
├─ flipbook/                 ← the reusable viewer (no PDF/app knowledge)
│  ├─ matrix.ts              Thin OO wrapper over `rematrix` + `transformX`. 4×4 matrix
│  │                         builder that emits a `matrix3d(...)` CSS string.
│  ├─ geometry.ts    ★       computePolygons(): pure cylinder-strip math. THE CORE.
│  │                         Given flip progress + page size, returns the per-strip
│  │                         transforms, lighting, z-order and bounding box.
│  ├─ lighting.ts            computeLighting(): pure. Ambient shadow + specular gloss
│  │                         gradients as a CSS background-image string.
│  ├─ Flipbook.tsx           The React component. Orchestration only: viewport sizing,
│  │                         flip state machine, rAF animation, pointer/zoom gestures,
│  │                         per-frame render of the strips. Imperative handle + props.
│  ├─ flipbook.css           Positioning, backface-visibility, transform-origin.
│  └─ index.ts               Public barrel export.
│
├─ pdf/
│  └─ renderPdf.ts           PDF ArrayBuffer → per-page image data-URLs via pdf.js,
│                            entirely client-side (canvas rasterization).
│
├─ App.tsx / App.css         Demo app: file upload, render spinner, toolbar, keyboard nav.
└─ main.tsx / index.css      React entry point.
```

`geometry.ts`, `lighting.ts` and `matrix.ts` are **pure and framework-agnostic** — zero
React, zero DOM — which is why they carry the unit tests (`*.test.ts`) and can be reasoned
about in isolation. `Flipbook.tsx` is the only file that touches React and the DOM.

---

## Data flow

```
PDF file ──renderPdf()──▶ string[] (data-URLs) ──▶ <Flipbook pages=… />
                                                        │
                        every animation frame:          ▼
              flip.progress ──computePolygons('front')──┐
                            └─computePolygons('back') ───┴─▶ strips ──▶ <div matrix3d> × 2N
```

- **`renderPdf(buffer, scale, onProgress)`** rasterizes each PDF page to a canvas and
  encodes it as WebP (PNG fallback). Returns the array of image URLs.
- **`<Flipbook pages={…} />`** takes those URLs and owns everything visual. It never knows
  the images came from a PDF — feed it any URLs.
- The parent stays in sync with the viewer through **`onStateChange`** (page number,
  can-flip / can-zoom flags) and drives it through the **imperative `ref` handle**
  (`flipLeft`, `flipRight`, `zoomIn`, `zoomOut`).

---

## Using the component

```tsx
import { useRef } from 'react'
import { Flipbook, type FlipbookHandle, type FlipbookSlot } from './flipbook'

const fb = useRef<FlipbookHandle>(null)

<Flipbook
  ref={fb}
  pages={imageUrls}                 // (string | null)[] — null = blank / cover
  nPolygons={10}                    // strips per page (smoothness)
  ambient={0.4}                     // shadow depth
  gloss={0.6}                       // highlight strength
  onStateChange={(s: FlipbookSlot) => updateToolbar(s)}
  onFlipRightEnd={(page) => console.log('now on', page)}
/>

// drive it imperatively:
fb.current?.flipRight()
fb.current?.zoomIn()
```

See `FlipbookProps` in `Flipbook.tsx` for every prop (all optional except `pages`), each
documented inline.

### Interactions (defaults)
- **Drag** left/right → page follows your finger; release past ¼ commits the flip, else it
  snaps back.
- **Click / tap** → cycles the zoom ladder (`clickToZoom`). When zoomed, drag to pan.
- **Arrow keys / toolbar buttons** → flip (wired in `App.tsx` via the imperative handle).
- Landscape viewport → two-page spread; portrait → single page (auto, via ResizeObserver).

---

## Tests

`bun run test` runs the vitest suite over the pure math:
- `matrix.test.ts` — identity, translate, rotate composition, `transformX`, `toString`.
- `geometry.test.ts` — strip count, matrix3d output, depth at progress 0/0.5, bounding box.
- `lighting.test.ts` — flat vs steep shading, gloss highlight, disabled-terms empty string.

---

## Credit

Rendering technique © Takeshi Sone — [`ts1/flipbook-vue`](https://github.com/ts1/flipbook-vue),
MIT License. This repository is an independent React/TypeScript reimplementation.
