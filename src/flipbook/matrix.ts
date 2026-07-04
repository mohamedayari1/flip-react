/*
 * Ported from flipbook-vue (https://github.com/ts1/flipbook-vue)
 * Original: src/matrix.coffee — Copyright (c) Takeshi Sone, MIT License.
 * Reimplemented in TypeScript for the React port.
 *
 * Thin OO wrapper over `rematrix` (framework-agnostic 4x4 matrix math), plus the
 * one custom method `transformX` used to project an x-coordinate for bounding-box math.
 */
import {
  identity,
  multiply,
  perspective,
  translate,
  translate3d,
  rotateY,
  toString,
  type Matrix3D,
} from 'rematrix'

export default class Matrix {
  m: number[]

  constructor(arg?: Matrix | number[] | null) {
    if (arg instanceof Matrix) {
      this.m = [...arg.m]
    } else if (arg) {
      this.m = [...arg]
    } else {
      this.m = identity()
    }
  }

  clone(): Matrix {
    return new Matrix(this)
  }

  multiply(m: number[]): this {
    this.m = multiply(this.m as Matrix3D, m as Matrix3D)
    return this
  }

  perspective(d: number): this {
    return this.multiply(perspective(d))
  }

  /** Project an x-coordinate through this matrix (perspective divide). */
  transformX(x: number): number {
    return (x * this.m[0] + this.m[12]) / (x * this.m[3] + this.m[15])
  }

  translate(x: number, y = 0): this {
    return this.multiply(translate(x, y))
  }

  translate3d(x: number, y: number, z: number): this {
    return this.multiply(translate3d(x, y, z))
  }

  rotateY(deg: number): this {
    return this.multiply(rotateY(deg))
  }

  toString(): string {
    return toString(this.m as Matrix3D)
  }
}
