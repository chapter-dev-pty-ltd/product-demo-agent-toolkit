import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { elevenlabs } from './voice/elevenlabs.ts'

// The voiceover. A film's lines are spoken before it's shot, by a provider that also says when
// each word is spoken; the shoot then performs to them, landing each action on its word, and
// the cut lays each line in where the shoot started it. Lines are kept in .product-demo/voice,
// so a line that hasn't changed is never paid for twice.

/** A word as spoken: from and to, in seconds from the start of its line. */
export interface Word {
  text: string
  start: number
  end: number
}

/** Who speaks the lines: a provider, one of its voices, and optionally its model. */
export interface VoiceChoice {
  provider: string
  voice: string
  model?: string | undefined
}

/** Something that turns text into speech, with when each word is spoken. */
export interface VoiceProvider {
  /** Its name, as people know it. */
  name: string
  /** The environment variable its key is kept in. */
  key: string
  /** Why a key doesn't work, or nothing when it does. */
  check(key: string): Promise<string | undefined>
  speak(text: string, choice: VoiceChoice): Promise<{ audio: Buffer; words: Word[] }>
}

export const PROVIDERS: Record<string, VoiceProvider> = { elevenlabs }

/** A line, spoken: its audio file, how long it runs, and its words. */
export interface Spoken {
  text: string
  file: string
  seconds: number
  words: Word[]
}

const DIR = join('.product-demo', 'voice')

/** Speaks every line, or takes it from what was spoken before. Two at a time, as providers limit it. */
export async function speakLines(
  lines: string[],
  choice: VoiceChoice,
): Promise<Map<string, Spoken>> {
  const provider = PROVIDERS[choice.provider]
  if (!provider) {
    throw new Error(
      `No voice provider called ${choice.provider}. There's ${Object.keys(PROVIDERS).join(', ')}.`,
    )
  }
  await mkdir(DIR, { recursive: true })
  const spoken = new Map<string, Spoken>()
  const queue = [...new Set(lines)]
  const speakOne = async (text: string) => {
    const key = createHash('sha256')
      .update(JSON.stringify([choice, text]))
      .digest('hex')
      .slice(0, 20)
    const file = resolve(DIR, `${key}.mp3`)
    const meta = resolve(DIR, `${key}.json`)
    if (!existsSync(file) || !existsSync(meta)) {
      const { audio, words } = await provider.speak(text, choice)
      await writeFile(file, audio)
      await writeFile(meta, JSON.stringify(words))
    }
    const words: Word[] = JSON.parse(await readFile(meta, 'utf8'))
    spoken.set(text, { text, file, words, seconds: (words.at(-1)?.end ?? 0) + 0.25 })
  }
  const worker = async () => {
    for (let text = queue.shift(); text !== undefined; text = queue.shift()) await speakOne(text)
  }
  await Promise.all([worker(), worker()])
  return spoken
}

/** When a word or phrase starts in a line, in seconds: its first match, ignoring case and punctuation. */
export function wordAt(line: Spoken, phrase: string): number | undefined {
  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')
  const wanted = phrase.split(/\s+/).map(clean).filter(Boolean)
  const words = line.words.map((w) => clean(w.text))
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((w, k) => words[i + k] === w)) return line.words[i]?.start
  }
  return undefined
}
