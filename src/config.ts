import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { VoiceChoice } from './voice.ts'

/** The backdrops in library/backdrops, by name. */
export const BACKDROPS = ['halo', 'sky', 'violet'] as const

/** How the app is shown: on the backdrop as it is, or in a browser window. */
export const DISPLAYS = ['none', 'browser'] as const
export type Display = (typeof DISPLAYS)[number]

/** The cursor's colours, as the cut draws it. */
export const CURSORS = ['pink', 'lime'] as const
export type Cursor = (typeof CURSORS)[number]

/** Which sounds the video has: all or none, or each on its own. */
export type Sound = boolean | { click?: boolean | undefined; typing?: boolean | undefined }

export const soundSchema: z.ZodType<Sound> = z.union([
  z.boolean(),
  z.strictObject({ click: z.boolean().optional(), typing: z.boolean().optional() }),
])

/** Whether a sound is on, given the film's setting over the config's. Each is on by default. */
export function soundOn(kind: 'click' | 'typing', ...settings: (Sound | undefined)[]): boolean {
  const setting = settings.find((s) => s !== undefined)
  return typeof setting === 'object' ? (setting[kind] ?? true) : (setting ?? true)
}

/** Emma, an ElevenLabs voice. */
const EMMA = '56bWURjYFHyYyVf490Dp'

export const voiceSchema: z.ZodObject<{
  provider: z.ZodString
  voice: z.ZodString
  model: z.ZodOptional<z.ZodString>
}> = z.strictObject({ provider: z.string(), voice: z.string(), model: z.string().optional() })

export interface Config {
  mode: 'ask' | 'just_do_it'
  backdrop: (typeof BACKDROPS)[number]
  display: Display
  cursor: Cursor
  sound: Sound
  voice: VoiceChoice
  keep: number
  review: boolean
}

const config: z.ZodType<Config> = z.strictObject({
  backdrop: z.enum(BACKDROPS).default('halo').describe('What the app is framed on in the video.'),
  display: z
    .enum(DISPLAYS)
    .default('none')
    .describe('How the app is shown: none, on the backdrop as it is, or in a browser window.'),
  cursor: z
    .enum(CURSORS)
    .default('pink')
    .describe("The cursor's colour in the video. A film can choose its own."),
  sound: soundSchema
    .default(true)
    .describe(
      'The video\'s sounds: true or false for all of them, or { "click": false } to choose each. A film can choose its own.',
    ),
  voice: voiceSchema
    .default({ provider: 'elevenlabs', voice: EMMA })
    .describe(
      "Who speaks the film's lines: a provider, one of its voice ids, and optionally a model.",
    ),
  keep: z
    .number()
    .int()
    .min(1)
    .default(10)
    .describe('How many rehearsals and shoots of each film to keep. Older ones are deleted.'),
  review: z
    .boolean()
    .default(false)
    .describe('Whether cut also makes a review image of the video, for the agent to check it.'),
  mode: z
    .enum(['ask', 'just_do_it'])
    .default('just_do_it')
    .describe(
      'ask: when something is unclear (which element, what the user meant), stop and ask the user. just_do_it: make the best choice and note it.',
    ),
})

const CONFIG_FILE: string = join('.product-demo', 'config.json')

/** The project's config, with defaults for anything it doesn't set. */
export async function readConfig(): Promise<Config> {
  let raw: unknown = {}
  try {
    const { $schema: _, ...rest } = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    raw = rest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parsed = config.safeParse(raw)
  if (!parsed.success)
    throw new Error(`${CONFIG_FILE} is not valid:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}
