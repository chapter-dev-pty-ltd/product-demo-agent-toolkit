import type { VoiceProvider, Word } from '../voice.ts'

const BASE = process.env.ELEVENLABS_BASE_URL ?? 'https://api.elevenlabs.io'
/** Steady delivery: Chapter found lower stability over-acted. */
const SETTINGS = { stability: 0.85, similarity_boost: 0.8, style: 0 }

export const elevenlabs: VoiceProvider = {
  name: 'ElevenLabs',
  key: 'ELEVENLABS_API_KEY',
  async check(key) {
    const response = await fetch(`${BASE}/v1/user`, { headers: { 'xi-api-key': key } })
    if (response.ok) return undefined
    const why = await response.text()
    if (why.includes('missing_permissions')) return undefined
    return refusal(response.status, why)
  },
  async speak(text, choice) {
    const key = process.env.ELEVENLABS_API_KEY
    if (!key)
      throw new Error('No ElevenLabs key. Save one with: product-demo-agent-toolkit key elevenlabs')
    const url = `${BASE}/v1/text-to-speech/${choice.voice}/with-timestamps?output_format=mp3_44100_128`
    const body = JSON.stringify({
      text,
      model_id: choice.model ?? 'eleven_v4',
      voice_settings: SETTINGS,
    })
    for (const wait of [2000, 6000, 15000, 0]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body,
      })
      if (response.ok) return read(await response.json())
      const retry = response.status === 429 || response.status >= 500
      if (!retry || wait === 0) {
        const why = refusal(response.status, await response.text())
        const next =
          response.status === 404
            ? ` The voice ${choice.voice} isn't in this account: add it from the Voice Library, or set another.`
            : response.status === 401
              ? ' Save a key that works with: product-demo-agent-toolkit key elevenlabs'
              : ''
        throw new Error(`${why}.${next}`)
      }
      await new Promise((done) => setTimeout(done, wait))
    }
    throw new Error('ElevenLabs did not answer.')
  },
}

export function refusal(status: number, body: string): string {
  let message: unknown
  try {
    const { detail }: { detail?: unknown } = JSON.parse(body)
    message =
      typeof detail === 'object' && detail !== null && 'message' in detail ? detail.message : detail
  } catch {}
  const said = typeof message === 'string' && message ? message : body.slice(0, 300)
  return `ElevenLabs said ${status}: ${said.trim().replace(/\.$/, '')}`
}

interface Answer {
  audio_base64: string
  alignment: {
    characters: string[]
    character_start_times_seconds: number[]
    character_end_times_seconds: number[]
  }
}

function read(answer: Answer): { audio: Buffer; words: Word[] } {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = answer.alignment
  const words: Word[] = []
  let current: Word | undefined
  characters.forEach((character, i) => {
    if (/\s/.test(character)) {
      if (current) words.push(current)
      current = undefined
      return
    }
    current ??= { text: '', start: starts[i] ?? 0, end: 0 }
    current.text += character
    current.end = ends[i] ?? current.end
  })
  if (current) words.push(current)
  return { audio: Buffer.from(answer.audio_base64, 'base64'), words }
}
