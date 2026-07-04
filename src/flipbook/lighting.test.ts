import { describe, it, expect } from 'vitest'
import { computeLighting } from './lighting'

describe('computeLighting', () => {
  it('flat strip (rot=0) → near-zero ambient darkening', () => {
    // gloss off so we only inspect ambient term
    const s = computeLighting(0, 0, 0.4, 0)
    // all diffuse stops should be ~0 (1 - cos(0) = 0)
    const nums = [...s.matchAll(/rgba\(0, 0, 0, ([0-9.eE-]+)\)/g)].map((m) => Number(m[1]))
    expect(nums.length).toBe(5)
    for (const n of nums) expect(n).toBeCloseTo(0, 6)
  })

  it('steep strip (rot=90) → strong ambient darkening', () => {
    const s = computeLighting(90, 0, 0.4, 0)
    const nums = [...s.matchAll(/rgba\(0, 0, 0, ([0-9.eE-]+)\)/g)].map((m) => Number(m[1]))
    // 1 - cos(90deg) = 1, times blackness 0.6 = 0.6
    for (const n of nums) expect(n).toBeCloseTo(0.6, 6)
  })

  it('returns empty string when both terms disabled', () => {
    expect(computeLighting(45, 5, 1, 0)).toBe('')
  })

  it('gloss produces a white highlight gradient', () => {
    const s = computeLighting(0, 0, 1, 0.6)
    expect(s).toContain('rgba(255, 255, 255')
    // at rot=0, cos(±30)^200 ≈ 0 → highlight faint away from centre; centre point d=0 strongest
    expect(s.startsWith('linear-gradient')).toBe(true)
  })

  it('emits two gradients when both terms active', () => {
    const s = computeLighting(45, 5, 0.4, 0.6)
    expect(s.match(/linear-gradient/g)?.length).toBe(2)
  })
})
