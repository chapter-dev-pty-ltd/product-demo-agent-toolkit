import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { HOME } from './home.ts'
import type { VoiceChoice } from './voice.ts'

/** The backdrops in library/backdrops, by name. */
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

/** How the app is shown: on the backdrop as it is, or in a browser window. */
export const DISPLAYS = ['none', 'browser'] as const
export type Display = (typeof DISPLAYS)[number]

/** The cursors the cut can draw: the rounded arrow in three colours, or a Mac's pointer. */
export const CURSORS = ['black', 'pink', 'lime', 'macos'] as const

/** A colour as hex, like `#8fd3ff`. */
export type Hex = `#${string}`

export function isHex(value: string): value is Hex {
  return /^#[0-9a-f]{6}$/i.test(value)
}

function isOneOf<T extends string>(list: readonly T[], value: string): value is T {
  return list.some((item) => item === value)
}

/** A file of the user's own, from a path in the config or a video's look (made absolute). */
export interface ProjectFile {
  file: string
}

/** The file at a path from the config, or an issue saying it isn't there. */
function projectFile(path: string, context: z.RefinementCtx): ProjectFile {
  const file = resolve(path)
  if (!existsSync(file))
    context.addIssue({ code: 'custom', message: `${path} isn't there (${file})` })
  return { file }
}

/** A library backdrop, a flat colour, or a picture of the project's own. */
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

/** One of the cursors, the rounded arrow in any colour, or an SVG of the project's own. */
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

/**
 * The cursor: which one, how big (1 is its own size), a label beside it, and for an SVG of
 * the project's own, where its tip is in it.
 */
export interface Cursor {
  style: CursorStyle
  size: number
  label?: string | undefined
  tip?: [number, number] | undefined
}

/** `"macos"` or `"#8fd3ff"` for one at its own size, or `{ "style": "macos", "size": 1.5 }`. */
const cursorSchema: z.ZodType<Cursor, unknown> = z.preprocess(
  (cursor) => (typeof cursor === 'string' ? { style: cursor } : cursor),
  z.strictObject({
    style: styleSchema.default('black'),
    size: z.number().min(0.5).max(3).default(1),
    label: z.string().trim().min(1).max(30).optional(),
    tip: z.tuple([z.number(), z.number()]).optional(),
  }),
)

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

/** The music in library/music, by name: two minutes each, looped when a video runs longer. */
export const MUSIC = ['lofi'] as const

/** Background music: one of ours by name, or an audio file of the project's own, and how loud. */
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

/** `false` for none, `"lofi"` or `"music/theme.mp3"`, or `{ "track": "lofi", "volume": 0.4 }`. */
const musicSchema: z.ZodType<Music | false, unknown> = z
  .preprocess(
    (music) => (typeof music === 'string' ? { track: music } : music === false ? null : music),
    z
      .strictObject({ track: trackSchema, volume: z.number().min(0).max(1).default(0.25) })
      .nullable(),
  )
  .transform((music) => music ?? false)

/** Jessica, one of ElevenLabs' own voices: every account has her. */
const JESSICA = 'cgSgspJ2msm6clMCkdW9'

export const voiceSchema: z.ZodObject<{
  provider: z.ZodString
  voice: z.ZodString
  model: z.ZodOptional<z.ZodString>
}> = z.strictObject({ provider: z.string(), voice: z.string(), model: z.string().optional() })

/** The app's window: its size in the browser, and how much of the video it fills. */
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

/** The default look for new videos, and the settings every video shares. */
export const CONFIG_FILE: string = join(HOME, 'config.json')

/**
 * The settings that make up a video's look and sound. Each video keeps its own copy in its
 * look.json, taken from the default when it's made, so a later change to the default never
 * changes a video that already exists.
 */
export const LOOK_KEYS = ['backdrop', 'display', 'window', 'cursor', 'sound', 'music'] as const
export type LookSettings = Pick<Config, (typeof LOOK_KEYS)[number]>

/**
 * The settings for a video: the shared config, with its look from `lookFile` when it has one.
 * Without one, the default look.
 */
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

/** A settings file as it's written, with its own files' paths made absolute (or {} if none). */
export async function readRaw(file: string): Promise<Record<string, unknown>> {
  let raw: Record<string, unknown> = {}
  try {
    const { $schema: _, ...rest } = JSON.parse(await readFile(file, 'utf8'))
    raw = rest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // A path is relative to the file it's written in, so it means the same file wherever the
  // settings are read from.
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

/** A look as it's written in a file: its own files by path, the rest as they are. */
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
