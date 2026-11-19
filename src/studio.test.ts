import { describe, expect, test } from 'vitest'
import { byteRange, trusted } from './studio.ts'

describe('the part of a file the browser asks for', () => {
  test('a span, an open end, and the last bytes', () => {
    expect(byteRange('bytes=0-', 100)).toEqual({ from: 0, to: 99 })
    expect(byteRange('bytes=10-19', 100)).toEqual({ from: 10, to: 19 })
    expect(byteRange('bytes=90-500', 100)).toEqual({ from: 90, to: 99 })
    expect(byteRange('bytes=-30', 100)).toEqual({ from: 70, to: 99 })
    expect(byteRange('bytes=-500', 100)).toEqual({ from: 0, to: 99 })
  })

  test('the whole file when it asks for no part', () => {
    expect(byteRange(undefined, 100)).toBeUndefined()
    expect(byteRange('bytes=-', 100)).toBeUndefined()
    expect(byteRange('bytes=0-9,20-29', 100)).toBeUndefined()
  })

  test('nothing past the end', () => {
    expect(byteRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(byteRange('bytes=20-10', 100)).toBe('unsatisfiable')
  })
})

describe('who may reach the studio', () => {
  test('its own page, by either of its names', () => {
    expect(trusted(4000, 'localhost:4000', 'http://localhost:4000')).toBe(true)
    expect(trusted(4000, '127.0.0.1:4000', 'http://127.0.0.1:4000')).toBe(true)
  })

  test("the agent's commands, which send no Origin", () => {
    expect(trusted(4000, '127.0.0.1:4000', undefined)).toBe(true)
  })

  test('not another site open in the browser', () => {
    expect(trusted(4000, 'localhost:4000', 'https://evil.example')).toBe(false)
    expect(trusted(4000, 'localhost:4000', 'http://localhost:3000')).toBe(false)
    expect(trusted(4000, 'localhost:4000', 'null')).toBe(false)
  })

  test('not a site that rebinds its own name to this machine', () => {
    expect(trusted(4000, 'evil.example:4000', undefined)).toBe(false)
    expect(trusted(4000, undefined, undefined)).toBe(false)
    expect(trusted(4000, 'localhost:4001', undefined)).toBe(false)
  })
})
