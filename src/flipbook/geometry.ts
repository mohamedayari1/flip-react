/*
 * geometry.ts — the heart of the 3D page-curl effect.
 *
 * Ported from flipbook-vue (https://github.com/ts1/flipbook-vue),
 * original makePolygonArray() in src/Flipbook.vue — Copyright (c) Takeshi Sone, MIT License.
 *
 * ============================================================================
 * HOW THE CURL WORKS (read this once and the whole file makes sense)
 * ============================================================================
 *
 * There is no WebGL and no <canvas> for the flip itself. A page that is turning is
 * sliced into `nPolygons` thin vertical strips (default 10). Each strip is a plain <div>
 * showing a slice of the page image. We wrap the strips around an imaginary vertical
 * CYLINDER using one CSS `matrix3d` transform per strip. Bending flat strips around a
 * cylinder is what your eye reads as a curling sheet of paper.
 *
 * Looking down at the book from above (the XZ plane, Y points down the page):
 *
 *        z (toward viewer)
 *        ▲
 *        │        ___----- strip 9  (far edge of the page, curled up/back)
 *        │    _--´
 *        │  ,´   strip i sits at angle `rad` around the cylinder of radius `r`
 *        │ /         x = sin(rad) · r     ← how far across the book
 *        │/          z = (1 - cos(rad))·r ← how far it lifts off the flat plane
 *   ─────●───────────────────────▶ x (across the spread)
 *      spine/origin
 *
 * Two things drive the shape, both derived from `progress` (0 = page flat at start,
 * 1 = page flat again, fully turned):
 *
 *   1. `theta` — the total arc the page wraps around the cylinder. It grows from ~0 at
 *      progress 0 to a maximum of PI (half a turn = strongly curled) at progress 0.5,
 *      then shrinks back to ~0 at progress 1. So the paper is FLAT when resting and
 *      most BENT in the middle of the flip — exactly how real paper behaves.
 *      `radius = pageWidth / theta`: small theta ⇒ huge radius ⇒ nearly flat.
 *
 *   2. `pageRotation` — a rigid Y-rotation of the whole page around the spine, from 0°
 *      to ±180°, that only kicks in during the SECOND half of the flip (progress > 0.5)
 *      to swing the (now-curled) page over to the other side.
 *
 * Each strip i is the same page image but shifted via `background-position` so strip 0
 * shows the left slice … strip 9 the right slice. Placed edge-to-edge along the cylinder
 * they reassemble into one continuous, curved page.
 *
 * The matrix per strip is built as:  pageMatrix · translate3d(x, 0, z) · rotateY(-rotate)
 *   - `pageMatrix` positions the page (perspective + spine placement + pageRotation)
 *   - `translate3d(x,0,z)` drops the strip onto its point on the cylinder
 *   - `rotateY(-rotate)` tilts the flat strip to sit tangent to the cylinder, so
 *     consecutive strips form a smooth curve instead of a faceted fan.
 *
 * FRONT vs BACK face: a turning sheet has two sides. We compute strips twice — the
 * `front` face (the side you were reading) and the `back` face (the next page, revealed
 * as the sheet lifts). The back face mirrors z and rotation and is offset by 180°.
 *
 * `minX`/`maxX`: while building strips we project each strip's left/right edge through
 * the matrix (Matrix.transformX) and track the extremes. The component uses this moving
 * bounding box to center the book and size the drop-shadow under it.
 *
 * This module is PURE: no React, no DOM, no side effects. Given the same options it
 * returns the same strips. That is what makes it unit-testable (see geometry.test.ts)
 * and cheap to call every animation frame.
 */
import Matrix from './matrix'
import { computeLighting } from './lighting'

export interface PolygonSpec {
  key: string
  /** page image url for this face (front vs back), or null for a blank page */
  image: string | null
  /** CSS background-image lighting gradient(s); '' when disabled */
  lighting: string
  /** CSS background-position for this strip's slice */
  bgPos: string
  /** matrix3d(...) transform string */
  transform: string
  /** stacking order derived from |z| depth */
  zIndex: number
}

export interface ComputePolygonsOptions {
  /** Which side of the turning sheet to build: the current page or the one behind it. */
  face: 'front' | 'back'
  /** Flip progress, 0 (flat, not started) → 1 (flat, fully turned). Drives the curl. */
  progress: number
  /** Which way the sheet is turning. */
  direction: 'left' | 'right'
  /** 1 = portrait/single-page mode, 2 = landscape spread. Changes the spine placement. */
  displayedPages: 1 | 2
  /** Reading direction: which visual side counts as "forward" (next page). */
  forwardDirection: 'left' | 'right'
  /** Rendered page size in px (image scaled to fit the viewport). */
  pageWidth: number
  pageHeight: number
  /** Viewport width in px; the spine sits at viewWidth/2 in spread mode. */
  viewWidth: number
  /** Horizontal/vertical gap between the page and the viewport edge, in px. */
  xMargin: number
  yMargin: number
  /** Number of vertical strips per page. More = smoother curl, more DOM nodes. */
  nPolygons: number
  /** CSS perspective distance in px (baked into the matrix, not the CSS property). */
  perspective: number
  /** Ambient light 0..1 — lower = darker shadow in the curl. See lighting.ts. */
  ambient: number
  /** Specular gloss 0..1 — strength of the highlight that sweeps the page. */
  gloss: number
  /** Page image URL for the front / back face (null renders a blank grey strip). */
  frontImage: string | null
  backImage: string | null
}

export interface ComputePolygonsResult {
  polygons: PolygonSpec[]
  minX: number
  maxX: number
  /** page opacity (single-page fade-out near end of flip); 0..1 */
  opacity: number
}

/**
 * Compute the strip transforms for ONE face of the turning sheet.
 *
 * Call it twice per frame — once with `face: 'front'`, once with `face: 'back'` — and
 * concatenate the results to render the whole flipping page. Merge the returned
 * `minX`/`maxX` across both faces to get the book's bounding box.
 *
 * @returns strips (one per `nPolygons`), the projected X bounds, and the page opacity.
 */
export function computePolygons(opts: ComputePolygonsOptions): ComputePolygonsResult {
  const {
    face,
    displayedPages,
    forwardDirection,
    pageWidth,
    viewWidth,
    xMargin,
    yMargin,
    nPolygons,
    perspective,
    ambient,
    gloss,
    frontImage,
    backImage,
  } = opts

  let progress = opts.progress
  let direction = opts.direction

  // Single-page mode: flipping "backward" is rendered as the forward flip reversed.
  if (displayedPages === 1 && direction !== forwardDirection) {
    progress = 1 - progress
    direction = forwardDirection
  }

  // In single-page mode the sheet has no visible back, so near the end of the turn we
  // fade the whole page out (0.7→1.0) to hide the abrupt swap to the next page.
  const opacity =
    displayedPages === 1 && progress > 0.7 ? 1 - (progress - 0.7) / 0.3 : 1

  const image = face === 'front' ? frontImage : backImage
  const polygonWidth = pageWidth / nPolygons

  // `pageX` = where the page's LEFT edge starts; `originRight` = whether the sheet is
  // hinged on its RIGHT edge (spine on the right) instead of the left. Which one applies
  // depends on face + direction + layout. These branches are a faithful copy of the
  // reference — they place each of the four cases (front/back × left/right) against the
  // correct spine so the curl pivots on the binding, not the outer edge.
  let pageX = xMargin
  let originRight = false
  if (displayedPages === 1) {
    if (forwardDirection === 'right') {
      if (face === 'back') {
        originRight = true
        pageX = xMargin - pageWidth
      }
    } else {
      if (direction === 'left') {
        if (face === 'back') {
          pageX = pageWidth - xMargin
        } else {
          originRight = true
        }
      } else {
        if (face === 'front') {
          pageX = pageWidth - xMargin
        } else {
          originRight = true
        }
      }
    }
  } else {
    if (direction === 'left') {
      if (face === 'back') {
        pageX = viewWidth / 2
      } else {
        originRight = true
      }
    } else {
      if (face === 'front') {
        pageX = viewWidth / 2
      } else {
        originRight = true
      }
    }
  }

  // The page-level matrix, shared by every strip (each strip clones then extends it).
  // Read right-to-left as applied to a point: first the perspective foreshortening about
  // the viewport centre, then a shift to the page's spine position. Applying perspective
  // here (rather than via the CSS `perspective` property) lets us bake it into one matrix.
  const pageMatrix = new Matrix()
  pageMatrix.translate(viewWidth / 2)
  pageMatrix.perspective(perspective)
  pageMatrix.translate(-viewWidth / 2)
  pageMatrix.translate(pageX, yMargin)

  // Rigid swing of the whole sheet about the spine. Only active in the second half of
  // the flip (progress > 0.5): 0° → ±180°. The back face is offset 180° so it faces the
  // opposite way from the front (a sheet's two sides always point opposite directions).
  let pageRotation = 0
  if (progress > 0.5) pageRotation = -(progress - 0.5) * 2 * 180
  if (direction === 'left') pageRotation = -pageRotation
  if (face === 'back') pageRotation += 180

  if (pageRotation) {
    // Rotate about the spine. When hinged on the right, translate to that edge first so
    // rotateY pivots there, then translate back.
    if (originRight) pageMatrix.translate(pageWidth)
    pageMatrix.rotateY(pageRotation)
    if (originRight) pageMatrix.translate(-pageWidth)
  }

  // `theta` = total arc the page wraps around the cylinder. Ramps 0 → PI over the first
  // half of the flip, then PI → 0 over the second half. Bigger theta = tighter curl.
  // `radius = pageWidth / theta` keeps the ARC LENGTH equal to the page width, so the
  // curved page always spans exactly one page's worth of paper. Guard theta==0 to avoid
  // divide-by-zero (a flat page is modelled as an arc of a near-infinite-radius circle).
  let theta =
    progress < 0.5
      ? progress * 2 * Math.PI
      : (1 - (progress - 0.5) * 2) * Math.PI
  if (theta === 0) theta = 1e-9
  const radius = pageWidth / theta

  // Walk the strips around the cylinder. `radian` is the current strip's angle (advances
  // by `dRadian` each strip). `rotate` is the tangent tilt applied to each flat strip so
  // the fan of strips reads as a smooth curve; it advances by `dRotate` per strip. The
  // originRight / back-face cases flip the direction of travel and the sign of the tilt.
  let radian = 0
  const dRadian = theta / nPolygons
  let rotate = dRadian / 2 / Math.PI * 180
  let dRotate = (dRadian / Math.PI) * 180
  if (originRight) rotate = (-theta / Math.PI) * 180 + dRotate / 2
  if (face === 'back') {
    rotate = -rotate
    dRotate = -dRotate
  }

  let minX = Infinity
  let maxX = -Infinity
  const polygons: PolygonSpec[] = []

  for (let i = 0; i < nPolygons; i++) {
    // `background-position` picks this strip's vertical slice of the full page image.
    // Strip 0 → 0% (left edge), last strip → 100% (right edge). The <div> only shows its
    // own slice because it is `pageWidth/nPolygons` wide with the full image as bg.
    const bgPos = `${(i / (nPolygons - 1)) * 100}% 0px`

    // Clone so each strip gets its own matrix — never mutate the shared pageMatrix.
    const m = pageMatrix.clone()

    // Position on the cylinder. `rad` is this strip's angle; originRight walks the arc
    // from the far end so the hinge stays on the right edge.
    const rad = originRight ? theta - radian : radian
    let x = Math.sin(rad) * radius // horizontal position across the spread
    if (originRight) x = pageWidth - x
    let z = (1 - Math.cos(rad)) * radius // lift off the flat plane (depth toward viewer)
    if (face === 'back') z = -z // back face curves the opposite way

    m.translate3d(x, 0, z) // drop the strip onto its cylinder point
    m.rotateY(-rotate) // tilt it tangent to the curve

    // Project this strip's left (x=0) and right (x=polygonWidth) edges through the full
    // matrix to screen X, and expand the running bounding box. Feeds centering + shadow.
    const x0 = m.transformX(0)
    const x1 = m.transformX(polygonWidth)
    maxX = Math.max(Math.max(x0, x1), maxX)
    minX = Math.min(Math.min(x0, x1), minX)

    // Per-strip shading from its facing angle (see lighting.ts). `pageRotation - rotate`
    // is the strip's true angle to the light; `dRotate` spreads the gradient across width.
    const lighting = computeLighting(pageRotation - rotate, dRotate, ambient, gloss)

    radian += dRadian
    rotate += dRotate

    polygons.push({
      key: face + i,
      image,
      lighting,
      bgPos,
      transform: m.toString(),
      // Depth-sort strips: those lifted furthest toward the viewer paint on top. Cheap
      // substitute for a real z-buffer, good enough because strips never interleave.
      zIndex: Math.abs(Math.round(z)),
    })
  }

  return { polygons, minX, maxX, opacity }
}
