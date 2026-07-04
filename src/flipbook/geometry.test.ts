import { describe, it, expect } from 'vitest'
import { computePolygons, type ComputePolygonsOptions } from './geometry'

const base: ComputePolygonsOptions = {
  face: 'front',
  progress: 0,
  direction: 'right',
  displayedPages: 2,
  forwardDirection: 'right',
  pageWidth: 400,
  pageHeight: 600,
  viewWidth: 800,
  xMargin: 0,
  yMargin: 0,
  nPolygons: 10,
  perspective: 2400,
  ambient: 0.4,
  gloss: 0.6,
  frontImage: 'front.jpg',
  backImage: 'back.jpg',
}

describe('computePolygons', () => {
  it('emits nPolygons strips', () => {
    const r = computePolygons({ ...base, progress: 0.5 })
    expect(r.polygons.length).toBe(10)
  })

  it('each strip carries a matrix3d transform and its face image', () => {
    const r = computePolygons({ ...base, progress: 0.5 })
    for (const p of r.polygons) {
      expect(p.transform).toMatch(/^matrix3d\(/)
      expect(p.image).toBe('front.jpg')
    }
  })

  it('background positions span 0% .. 100%', () => {
    const r = computePolygons({ ...base, progress: 0.5 })
    expect(r.polygons[0].bgPos).toBe('0% 0px')
    expect(r.polygons[9].bgPos).toBe('100% 0px')
  })

  it('progress 0 → page flat (all strips at ~zero depth)', () => {
    const r = computePolygons({ ...base, progress: 0 })
    // theta ~ 0 → radius huge but z = (1-cos(rad))·r stays ~0 → zIndex 0
    for (const p of r.polygons) expect(p.zIndex).toBe(0)
  })

  it('mid-flip (progress 0.5) develops depth', () => {
    const r = computePolygons({ ...base, progress: 0.5 })
    const maxZ = Math.max(...r.polygons.map((p) => p.zIndex))
    expect(maxZ).toBeGreaterThan(0)
  })

  it('back face uses the back image', () => {
    const r = computePolygons({ ...base, face: 'back', progress: 0.5 })
    for (const p of r.polygons) expect(p.image).toBe('back.jpg')
  })

  it('single-page mode fades opacity near end of flip', () => {
    const r = computePolygons({ ...base, displayedPages: 1, progress: 0.85 })
    expect(r.opacity).toBeLessThan(1)
    expect(r.opacity).toBeGreaterThanOrEqual(0)
  })

  it('reports a finite bounding box', () => {
    const r = computePolygons({ ...base, progress: 0.5 })
    expect(Number.isFinite(r.minX)).toBe(true)
    expect(Number.isFinite(r.maxX)).toBe(true)
    expect(r.maxX).toBeGreaterThan(r.minX)
  })
})
