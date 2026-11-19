import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { HOME } from './home.ts'
import type { VoiceChoice } from './voice.ts'

export const BACKDROPS = [
  'halo',
  'sky',
  'violet',
  'orchid',
  'dusk-halo',
  'dusk-mesh',
  'dusk-corners',
  'dusk-fade',
  'glacier-halo',
  'glacier-mesh',
  'glacier-wave',
  'glacier-fade',
  'citrus-halo',
  'citrus-warp',
  'citrus-corners',
  'citrus-fade',
  'graphite-halo',
  'graphite-mesh',
  'graphite-sphere',
  'graphite-fade',
  'candy-clouds',
  'peach-dawn',
] as const

export const DISPLAYS = ['none', 'browser'] as const
export type Display = (typeof DISPLAYS)[number]

export const CURSORS = ['black', 'pink', 'lime', 'macos'] as const

export type Hex = `#${string}`

export function isHex(value: string): value is Hex {
  return /^#[0-9a-f]{6}$/i.test(value)
}

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return list.some((item) => item === value)
}

export interface ProjectFile {
  file: string
}

function projectFile(path: string, context: z.RefinementCtx): ProjectFile {
  const file = resolve(path)
  if (!existsSync(file))
    context.addIssue({ code: 'custom', message: `${path} isn't there (${file})` })
  return { file }
}

export type Backdrop = (typeof BACKDROPS)[number] | Hex | ProjectFile

const backdropSchema = z.string().transform((value, context): Backdrop => {
  if (isOneOf(BACKDROPS, value) || isHex(value)) return value
  if (/\.(jpe?g|png|webp)$/i.test(value)) return projectFile(value, context)
  context.addIssue({
    code: 'custom',
    message: `"${value}" isn't a backdrop: use one in library/backdrops (like "sky"), a hex colour like "#f4f1ea", or a path to a .jpg, .png or .webp`,
  })
  return z.NEVER
})

export type CursorStyle = (typeof CURSORS)[number] | Hex | ProjectFile

const styleSchema = z.string().transform((value, context): CursorStyle => {
  if (isOneOf(CURSORS, value) || isHex(value)) return value
  if (/\.svg$/i.test(value)) return projectFile(value, context)
  context.addIssue({
    code: 'custom',
    message: `"${value}" isn't a cursor: use ${CURSORS.join(', ')}, a hex colour like "#8fd3ff", or a path to an .svg`,
  })
  return z.NEVER
})

export interface Cursor {
  style: CursorStyle
  size: number
  label?: string | undefined
  tip?: [number, number] | undefined
}

const cursorSchema: z.ZodType<Cursor, unknown> = z.preprocess(
  (cursor) => (typeof cursor === 'string' ? { style: cursor } : cursor),
  z.strictObject({
    style: styleSchema.default('black'),
    size: z.number().min(0.5).max(3).default(1),
    label: z.string().trim().min(1).max(30).optional(),
    tip: z.tuple([z.number(), z.number()]).optional(),
  }),
)

export type Sound = boolean | { click?: boolean | undefined; typing?: boolean | undefined }

export const soundSchema: z.ZodType<Sound> = z.union([
  z.boolean(),
  z.strictObject({ click: z.boolean().optional(), typing: z.boolean().optional() }),
])

export function soundOn(kind: 'click' | 'typing', setting: Sound): boolean {
  return typeof setting === 'object' ? (setting[kind] ?? true) : setting
}

export const MUSIC = ['lofi'] as const

export interface Music {
  track: (typeof MUSIC)[number] | ProjectFile
  volume: number
}

const trackSchema = z.string().transform((value, context): Music['track'] => {
  if (isOneOf(MUSIC, value)) return value
  if (/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(value)) return projectFile(value, context)
  context.addIssue({
    code: 'custom',
    message: `"${value}" isn't music: use ${MUSIC.join(', ')}, or a path to an .mp3, .m4a, .aac, .wav, .ogg or .flac`,
  })
  return z.NEVER
})

const musicSchema: z.ZodType<Music | false, unknown> = z
  .preprocess(
    (music) => (typeof music === 'string' ? { track: music } : music === false ? null : music),
    z
      .strictObject({ track: trackSchema, volume: z.number().min(0).max(1).default(0.25) })
      .nullable(),
  )
  .transform((music) => music ?? false)

const JESSICA = 'cgSgspJ2msm6clMCkdW9'

export const voiceSchema: z.ZodObject<{
  provider: z.ZodString
  voice: z.ZodString
  model: z.ZodOptional<z.ZodString>
}> = z.strictObject({ provider: z.string(), voice: z.string(), model: z.string().optional() })

export interface AppWindow {
  width: number
  height: number
  fill: number
}

export interface Config {
  mode: 'ask' | 'just_do_it'
  backdrop: Backdrop
  display: Display
  window: AppWindow
  cursor: Cursor
  sound: Sound
  music: Music | false
  voice: VoiceChoice
  keep: number
  review: boolean
}

const config: z.ZodType<Config> = z.strictObject({
  backdrop: backdropSchema
    .default('sky')
    .describe(
      "What the app is framed on in the video: one in library/backdrops, a hex colour, or a path to a picture of the project's own (.jpg, .png or .webp).",
    ),
  display: z
    .enum(DISPLAYS)
    .default('none')
    .describe('How the app is shown: none, on the backdrop as it is, or in a browser window.'),
  cursor: cursorSchema
    .default({ style: 'black', size: 1 })
    .describe(
      'The cursor in the video: its style (the rounded arrow in black, pink or lime, or in any hex colour like "#8fd3ff", macos, or a path to an .svg of the project\'s own, with its "tip" as [x, y] in it) and size (1 is its own size, 1.5 half as big again), and optionally a label shown beside it, like "Agent". A style alone is fine: "macos".',
    ),
  sound: soundSchema
    .default(true)
    .describe(
      'The video\'s sounds: true or false for all of them, or { "click": false } to choose each.',
    ),
  music: musicSchema
    .default(false)
    .describe(
      'Background music under the whole video, looped if the video runs longer and faded out at the end: false for none, ours (lofi), the path to an audio file in the project, or { "track": "lofi", "volume": 0.4 } (0.25 by default).',
    ),
  voice: voiceSchema
    .default({ provider: 'elevenlabs', voice: JESSICA })
    .describe(
      "Who speaks the film's lines: a provider, one of its voice ids, and optionally a model.",
    ),
  window: z
    .strictObject({
      width: z.number().int().min(800).max(2560).default(1600),
      height: z.number().int().min(600).max(1600).default(900),
      fill: z.number().min(0.5).max(1).default(0.92),
    })
    .default({ width: 1600, height: 900, fill: 0.92 })
    .describe(
      "The app's window: its width and height in the browser (changing them needs a new shoot), and how much of the video it fills, 0.5 to 1 (a re-cut is enough).",
    ),
  keep: z
    .number()
    .int()
    .min(1)
    .default(5)
    .describe('How many rehearsals and takes of each video to keep. Older ones are deleted.'),
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

export const CONFIG_FILE: string = join(HOME, 'config.json')

export const LOOK_KEYS = ['backdrop', 'display', 'window', 'cursor', 'sound', 'music'] as const
export type LookSettings = Pick<Config, (typeof LOOK_KEYS)[number]>

export async function readConfig(lookFile?: string): Promise<Config> {
  const shared = await readRaw(CONFIG_FILE)
  const look = lookFile ? await readRaw(lookFile) : {}
  const raw = { ...shared, ...look }
  const parsed = config.safeParse(raw)
  if (!parsed.success) {
    const where = lookFile ? `${CONFIG_FILE} with ${lookFile}` : CONFIG_FILE
    throw new Error(`${where} is not valid:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

export async function readRaw(file: string): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> = {}
  try {
    const { $schema: _, ...rest } = JSON.parse(await readFile(file, 'utf8'))
    raw = rest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const base = dirname(file)
  const path = (value: unknown) =>
    typeof value === 'string' && /[/\\]|\.\w+$/.test(value) && !value.startsWith('#')
      ? resolve(base, value)
      : value
  const inside = (value: unknown, key: string) =>
    value && typeof value === 'object' && key in value
      ? { ...value, [key]: path((value as Record<string, unknown>)[key]) }
      : path(value)
  if ('backdrop' in raw) raw.backdrop = path(raw.backdrop)
  if ('cursor' in raw) raw.cursor = inside(raw.cursor, 'style')
  if ('music' in raw) raw.music = inside(raw.music, 'track')
  return raw
}

export function lookToRaw(look: LookSettings): Record<string, unknown> {
  const written = <T>(value: T | ProjectFile): T | string =>
    typeof value === 'object' && value !== null && 'file' in value ? value.file : value
  const { size, label, tip } = look.cursor
  const music = look.music
  return {
    backdrop: written(look.backdrop),
    display: look.display,
    window: look.window,
    cursor: {
      style: written(look.cursor.style),
      size,
      ...(label ? { label } : {}),
      ...(tip ? { tip } : {}),
    },
    sound: look.sound,
    music: music ? { track: written(music.track), volume: music.volume } : false,
  }
}
