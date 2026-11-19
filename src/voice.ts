import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { elevenlabs } from './voice/elevenlabs.ts'

export interface Word {
  text: string
  start: number
  end: number
}

export interface VoiceChoice {
  provider: string
  voice: string
  model?: string | undefined
}

export interface VoiceProvider {
  name: string
  key: string
  check(key: string): Promise<string | undefined>
  speak(text: string, choice: VoiceChoice): Promise<{ audio: Buffer; words: Word[] }>
}

export const PROVIDERS: Record<string, VoiceProvider> = { elevenlabs }

export interface Spoken {
  text: string
  file: string
  seconds: number
  words: Word[]
}

const DIR = join('.product-demo', 'voice')

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

export function wordAt(line: Spoken, phrase: string): number | undefined {
  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')
  const wanted = phrase.split(/\s+/).map(clean).filter(Boolean)
  const words = line.words.map((w) => clean(w.text))
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((w, k) => words[i + k] === w)) return line.words[i]?.start
  }
  return undefined
}
