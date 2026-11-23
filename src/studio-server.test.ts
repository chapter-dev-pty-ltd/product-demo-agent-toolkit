import { describe, expect, test } from 'vitest'
import { fromPage, trusted } from './studio-server.ts'

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

describe('settings from the page', () => {
  const was = {
    backdrop: 'sky',
    display: 'browser',
    window: { width: 1600, height: 900, fill: 0.9 },
    cursor: { style: 'black', size: 1, label: 'Doc' },
    music: false,
    sound: true,
  } as const
  const mine = { cursor: { file: '/project/cursor.svg' }, tip: [2, 3] as [number, number] }

  test('keeps what it leaves out, and clears the label only when it is empty', () => {
    expect(fromPage({ fill: 0.75 }, was, {})).toEqual({
      ...was,
      window: { ...was.window, fill: 0.75 },
    })
    expect(fromPage({ cursor: { label: '  ' } }, was, {}).cursor).toEqual({
      style: 'black',
      size: 1,
    })
  })

  test("uses the project's own file, and its tip, for 'own'", () => {
    const own = fromPage({ cursor: { style: 'own' } }, was, mine)
    expect(own.cursor).toMatchObject({ style: mine.cursor, tip: [2, 3] })
    expect(fromPage({ cursor: { style: 'pink' } }, own, mine).cursor.tip).toBeUndefined()
    expect(() => fromPage({ backdrop: 'own' }, was, mine)).toThrow(
      "There's no backdrop of your own",
    )
  })
})
