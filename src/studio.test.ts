import { describe, expect, test } from 'vitest'
import { sameStep, trusted } from './studio.ts'

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

describe('finding a step of the take in the film as it is now', () => {
  const search = { fill: { css: '#q' }, text: 'gta 5' }
  const enter = { press: 'Enter' }
  const open = { click: { css: '#video' }, highlight: { style: 'magnify' } }

  test('in the same place, whatever its direction says now', () => {
    expect(sameStep([search, enter, open], [search, enter, { ...open, highlight: {} }], 2)).toBe(2)
  })

  test('where it moved to, after a step before it was deleted or added', () => {
    expect(sameStep([search, enter, open], [search, open], 2)).toBe(1)
    expect(sameStep([search, enter, open], [{ visit: '/' }, search, enter, open], 2)).toBe(3)
  })

  test('nowhere, when it was changed, removed, or there are several like it', () => {
    expect(sameStep([search, enter, open], [search, enter], 2)).toBe(-1)
    expect(sameStep([search], [{ ...search, text: 'gta 6' }], 0)).toBe(-1)
    expect(sameStep([enter, search], [search, enter, enter], 0)).toBe(-1)
  })
})
