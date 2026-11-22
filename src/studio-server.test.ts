import { describe, expect, test } from 'vitest'
import { trusted } from './studio-server.ts'

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
