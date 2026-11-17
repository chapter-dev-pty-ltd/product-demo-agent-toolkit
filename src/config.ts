import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { VoiceChoice } from './voice.ts'

/** The backdrops in library/backdrops, by name. */
export const BACKDROPS = ['halo', 'sky', 'violet'] as const

/** How the app is shown: on the backdrop as it is, or in a browser window. */
export const DISPLAYS = ['none', 'browser'] as const
export type Display = (typeof DISPLAYS)[number]

/** The cursors the cut can draw: the rounded arrow in three colours, or a Mac's pointer. */
export const CURSORS = ['black', 'pink', 'lime', 'macos'] as const

/** The cursor: which one, how big (1 is its own size), and a label beside it. */
export interface Cursor {
  style: (typeof CURSORS)[number]
  size: number
  label?: string | undefined
}

/** `"macos"` for one at its own size, or `{ "style": "macos", "size": 1.5 }`. */
const cursorSchema: z.ZodType<Cursor, unknown> = z
  .union([
    z.enum(CURSORS),
    z.strictObject({
      style: z.enum(CURSORS).default('black'),
      size: z.number().min(0.5).max(3).default(1),
      label: z.string().trim().min(1).max(30).optional(),
    }),
  ])
  .transform((cursor) => (typeof cursor === 'string' ? { style: cursor, size: 1 } : cursor))

/** Which sounds the video has: all or none, or each on its own. */
export type Sound = boolean | { click?: boolean | undefined; typing?: boolean | undefined }

export const soundSchema: z.ZodType<Sound> = z.union([
  z.boolean(),
  z.strictObject({ click: z.boolean().optional(), typing: z.boolean().optional() }),
])

/** Whether a sound is on, by the config: all of them, or each on its own (on by default). */
export function soundOn(kind: 'click' | 'typing', setting: Sound): boolean {
  return typeof setting === 'object' ? (setting[kind] ?? true) : setting
}

/** Jessica, one of ElevenLabs' own voices: every account has her. */
const JESSICA = 'cgSgspJ2msm6clMCkdW9'

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
  cursor: cursorSchema
    .default({ style: 'black', size: 1 })
    .describe(
      'The cursor in the video: its style (the rounded arrow in black, pink or lime, or macos) and size (1 is its own size, 1.5 half as big again), and optionally a label shown beside it, like "Agent". A style alone is fine: "macos".',
    ),
  sound: soundSchema
    .default(true)
    .describe(
      'The video\'s sounds: true or false for all of them, or { "click": false } to choose each.',
    ),
  voice: voiceSchema
    .default({ provider: 'elevenlabs', voice: JESSICA })
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
