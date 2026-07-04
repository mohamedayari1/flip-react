import { describe, it, expect } from 'vitest'
import Matrix from './matrix'

describe('Matrix', () => {
  it('identity by default', () => {
    const m = new Matrix()
    expect(m.m).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  })

  it('clone is independent', () => {
    const a = new Matrix()
    const b = a.clone()
    b.translate(10, 0)
    expect(a.m[12]).toBe(0) // original untouched
    expect(b.m[12]).toBe(10)
  })

  it('translate sets the translation column', () => {
    const m = new Matrix().translate(5, 7)
    expect(m.m[12]).toBe(5)
    expect(m.m[13]).toBe(7)
  })

  it('translate3d sets z', () => {
    const m = new Matrix().translate3d(1, 2, 3)
    expect(m.m[12]).toBe(1)
    expect(m.m[13]).toBe(2)
    expect(m.m[14]).toBe(3)
  })

  it('rotateY 180 flips x sign', () => {
    const m = new Matrix().rotateY(180)
    // cos(180) = -1 → m[0] ~ -1
    expect(m.m[0]).toBeCloseTo(-1, 6)
  })

  it('transformX with identity returns the input', () => {
    const m = new Matrix()
    expect(m.transformX(42)).toBeCloseTo(42, 6)
  })

  it('transformX after translate offsets the point', () => {
    const m = new Matrix().translate(100, 0)
    // (x*1 + 100) / (x*0 + 1) = x + 100
    expect(m.transformX(10)).toBeCloseTo(110, 6)
  })

  it('toString emits matrix3d(...)', () => {
    const s = new Matrix().toString()
    expect(s).toMatch(/^matrix3d\(/)
    expect(s.split(',').length).toBe(16)
  })
})
