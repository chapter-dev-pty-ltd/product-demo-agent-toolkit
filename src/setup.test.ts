import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { loadKeys } from './setup.ts'
import { refusal } from './voice/elevenlabs.ts'

const KEY = 'ELEVENLABS_API_KEY'
const dir = mkdtempSync(join(tmpdir(), 'product-demo-keys-'))

/** A .env file with this in it, and where it is. */
function dotenv(name: string, text: string): string {
  const file = join(dir, name)
  writeFileSync(file, text)
  return file
}

// A project's own .env, as most have: the app's settings, and nothing about a voice.
const project = dotenv('project.env', 'DATABASE_URL=postgres://localhost/app\nAPP_URL=http://x\n')
const home = dotenv('home.env', `${KEY}=saved-for-every-project\n`)
const missing = join(dir, 'no-such.env')

describe('loadKeys', () => {
  // These two use the real process.env, which turns whatever it's given into a string: a
  // key that isn't there must not become the word "undefined".
  const mine = process.env[KEY]
  beforeEach(() => {
    delete process.env[KEY]
  })
  afterAll(() => {
    if (mine === undefined) delete process.env[KEY]
    else process.env[KEY] = mine
  })

  test("a project .env that doesn't name the key leaves it unset", () => {
    loadKeys([project, missing])
    expect(process.env[KEY]).toBeUndefined()
  })

  test("a project .env that doesn't name the key leaves it to the one saved at home", () => {
    loadKeys([project, home])
    expect(process.env[KEY]).toBe('saved-for-every-project')
  })

  test('a blank key in the project .env leaves it to the one saved at home', () => {
    const env: NodeJS.ProcessEnv = {}
    loadKeys([dotenv('blank.env', `${KEY}=\n`), home], env)
    expect(env[KEY]).toBe('saved-for-every-project')
  })

  test("the project's key is used over the one saved at home", () => {
    const env: NodeJS.ProcessEnv = {}
    loadKeys([dotenv('own.env', `${KEY}=this-project's\n`), home], env)
    expect(env[KEY]).toBe("this-project's")
  })

  test("a key already in the environment isn't replaced", () => {
    const env: NodeJS.ProcessEnv = { [KEY]: 'from-the-shell' }
    loadKeys([dotenv('own.env', `${KEY}=this-project's\n`), home], env)
    expect(env[KEY]).toBe('from-the-shell')
  })

  test('no .env anywhere leaves the key unset', () => {
    const env: NodeJS.ProcessEnv = {}
    loadKeys([missing, missing], env)
    expect(env[KEY]).toBeUndefined()
  })
})

describe('refusal', () => {
  test("says ElevenLabs' own message, not the JSON around it", () => {
    const body =
      '{"detail":{"type":"authentication_error","code":"unauthorized","message":"Invalid API key","status":"invalid_api_key","request_id":"a64fd92e202615278ef979ff9cbcfed5"}}'
    expect(refusal(401, body)).toBe('ElevenLabs said 401: Invalid API key')
  })

  test('says a plain detail as it is', () => {
    expect(refusal(404, '{"detail":"Not Found."}')).toBe('ElevenLabs said 404: Not Found')
  })

  test("says what came when it isn't that shape", () => {
    expect(refusal(502, 'Bad Gateway')).toBe('ElevenLabs said 502: Bad Gateway')
    expect(refusal(422, '{"detail":[{"loc":["body","text"]}]}')).toBe(
      'ElevenLabs said 422: {"detail":[{"loc":["body","text"]}]}',
    )
  })
})
