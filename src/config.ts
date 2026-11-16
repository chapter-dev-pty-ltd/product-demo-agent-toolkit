import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** The backdrops in library/backdrops, by name. */
export const BACKDROPS = ['halo', 'sky', 'violet'] as const

/** The cursor's colours, as the cut draws it. */
export const CURSORS = ['pink', 'lime'] as const
export type Cursor = (typeof CURSORS)[number]

export interface Config {
  mode: 'ask' | 'just_do_it'
  backdrop: (typeof BACKDROPS)[number]
  cursor: Cursor
  keep: number
  review: boolean
}

const config: z.ZodType<Config> = z.strictObject({
  backdrop: z.enum(BACKDROPS).default('halo').describe('What the app is framed on in the video.'),
  cursor: z
    .enum(CURSORS)
    .default('pink')
    .describe("The cursor's colour in the video. A film can choose its own."),
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
    .default('ask')
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
