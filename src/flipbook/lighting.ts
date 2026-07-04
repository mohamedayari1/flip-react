/*
 * lighting.ts — the shading that makes flat strips look like curved, glossy paper.
 *
 * Ported from flipbook-vue (https://github.com/ts1/flipbook-vue),
 * original computeLighting() in src/Flipbook.vue — Copyright (c) Takeshi Sone, MIT License.
 *
 * ============================================================================
 * THE LIGHTING MODEL
 * ============================================================================
 *
 * Geometry alone gives you the shape of the curl; lighting is what sells it as paper.
 * Each strip gets a CSS `background-image` overlay built from up to two linear gradients,
 * both a function of the strip's facing angle `rot` (how tilted it is toward the light):
 *
 *   1. AMBIENT / DIFFUSE (the shadow) — active when `ambient < 1`.
 *      Brightness falls off as the strip turns away from the light, using a Lambert-style
 *      `1 - cos(angle)` term scaled by `blackness = 1 - ambient`. Emitted as a BLACK
 *      `linear-gradient(to right, …)` so the trailing side of the curl darkens. This is
 *      the soft shadow you see pooling where the page bends away.
 *
 *   2. SPECULAR / GLOSS (the highlight) — active when `gloss > 0`.
 *      A tight WHITE highlight modelled as `cos(angle ± 30°) ^ 200`. The huge exponent
 *      (POW = 200) makes it a razor-thin band — a mirror-like sheen rather than a broad
 *      glow. As the strip angle changes during the flip, the peak of this band slides
 *      across the page: that travelling glint is the single most convincing cue that the
 *      surface is glossy and moving. The `± 30°` (DEG) samples two lobes and takes the
 *      max so the sheen reads well from either tilt direction.
 *
 * Each gradient is sampled at five points across the strip's width — [-0.5 … +0.5] — so
 * the shading varies smoothly WITHIN a strip too, not just between strips. `dRotate`
 * (the per-strip angle step) offsets those samples so the gradient stays continuous when
 * strips are laid side by side.
 *
 * Returns a comma-joined `background-image` string (CSS layers the gradients), or '' when
 * both terms are switched off — in which case the component skips the overlay entirely.
 *
 * Pure function: no DOM, no state. Trivially unit-testable (see lighting.test.ts).
 */

/** Sample offsets across a strip's width, from left edge (-0.5) to right edge (+0.5). */
const LIGHTING_POINTS = [-0.5, -0.25, 0, 0.25, 0.5]

/**
 * Build the CSS `background-image` lighting overlay for one strip.
 *
 * @param rot     strip facing angle in degrees (`pageRotation - rotate` for this strip)
 * @param dRotate per-strip rotation delta in degrees (spreads the gradient across width)
 * @param ambient 0..1 — ambient light level (lower = darker shadows). Overlay active when < 1
 * @param gloss   0..1 — specular highlight strength. Overlay active when > 0
 * @returns comma-joined gradient string, or '' if both terms are disabled
 */
export function computeLighting(
  rot: number,
  dRotate: number,
  ambient: number,
  gloss: number,
): string {
  const gradients: string[] = []

  // --- Ambient shadow: darkens as the strip turns away from the light ---
  if (ambient < 1) {
    const blackness = 1 - ambient
    // Lambert term 1 - cos(θ): 0 when facing the light, up to 2 when facing away,
    // scaled by blackness. Sampled left→right so the gradient darkens across the strip.
    const diffuse = LIGHTING_POINTS.map(
      (d) => (1 - Math.cos(((rot - dRotate * d) / 180) * Math.PI)) * blackness,
    )
    gradients.push(
      `linear-gradient(to right,` +
        ` rgba(0, 0, 0, ${diffuse[0]}),` +
        ` rgba(0, 0, 0, ${diffuse[1]}) 25%,` +
        ` rgba(0, 0, 0, ${diffuse[2]}) 50%,` +
        ` rgba(0, 0, 0, ${diffuse[3]}) 75%,` +
        ` rgba(0, 0, 0, ${diffuse[4]}))`,
    )
  }

  // --- Specular gloss: a thin white highlight that slides across the page ---
  if (gloss > 0) {
    const DEG = 30 // two highlight lobes at ±30°, so the sheen reads from either tilt
    const POW = 200 // very high exponent → razor-thin, mirror-like band (not a soft glow)
    const specular = LIGHTING_POINTS.map((d) =>
      Math.max(
        Math.cos(((rot + DEG - dRotate * d) / 180) * Math.PI) ** POW,
        Math.cos(((rot - DEG - dRotate * d) / 180) * Math.PI) ** POW,
      ),
    )
    gradients.push(
      `linear-gradient(to right,` +
        ` rgba(255, 255, 255, ${specular[0] * gloss}),` +
        ` rgba(255, 255, 255, ${specular[1] * gloss}) 25%,` +
        ` rgba(255, 255, 255, ${specular[2] * gloss}) 50%,` +
        ` rgba(255, 255, 255, ${specular[3] * gloss}) 75%,` +
        ` rgba(255, 255, 255, ${specular[4] * gloss}))`,
    )
  }

  return gradients.join(',')
}
