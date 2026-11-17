import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pkg from '../package.json' with { type: 'json' }
import { readConfig } from './config.ts'
import { findFfmpeg, launchBrowser } from './tools.ts'
import { PROVIDERS, type VoiceProvider } from './voice.ts'

// Getting a project ready, and keeping keys. A key is looked for in the environment, then the
// project's .env, then ~/.product-demo/.env, so one saved there works in every project.

const HOME_ENV = join(homedir(), '.product-demo', '.env')

/**
 * Loads the voice providers' keys from the project's .env, then the home one. Only those keys:
 * the rest of an app's .env stays out of the browser and ffmpeg. Neither overrides what's set.
 */
export function loadKeys(): void {
  const keys = Object.values(PROVIDERS).map((provider) => provider.key)
  for (const file of ['.env', HOME_ENV]) {
    let found: Record<string, string | undefined>
    try {
      found = parseEnv(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const key of keys) process.env[key] ??= found[key]
  }
}

const COMMAND = 'product-demo-agent-toolkit'

/** Copies the skills into an agent's skills folder: Claude Code's, unless told another. */
export async function installSkills(
  to: string = join(homedir(), '.claude', 'skills'),
): Promise<string> {
  await cp(fileURLToPath(new URL('../skills', import.meta.url)), to, { recursive: true })
  return to
}

/**
 * Everything a new user needs, once: the command installed for good (when this is run with
 * npx, or an older version is installed), and the skills. The agent runs `init` in each
 * project itself.
 */
export async function setup(): Promise<string[]> {
  const said: string[] = []
  // Asked of npm's global packages, not the PATH: under npx, the command is on the PATH only
  // until npx exits.
  const listed = spawnSync('npm', ['ls', '-g', '--depth=0', '--json', pkg.name], {
    encoding: 'utf8',
  })
  const globals: unknown = JSON.parse(listed.stdout || '{}')
  const installed =
    typeof globals === 'object' && globals !== null && 'dependencies' in globals
      ? Reflect.get(Reflect.get(globals.dependencies ?? {}, pkg.name) ?? {}, 'version')
      : undefined
  if (installed === pkg.version) {
    said.push(`The ${COMMAND} command is installed (${pkg.version}).`)
  } else {
    console.log(`Installing the ${COMMAND} command…`)
    const npm = spawnSync('npm', ['install', '-g', `${pkg.name}@${pkg.version}`], {
      stdio: 'inherit',
    })
    if (npm.status !== 0) {
      throw new Error(
        `Couldn't install it. Run npm install -g ${pkg.name} yourself, then ${COMMAND} skills.`,
      )
    }
    said.push(`Installed the ${COMMAND} command (${pkg.version}).`)
  }
  said.push(`Copied the skills into ${await installSkills()}.`)
  said.push(
    'Ready. Start a new session with your agent in your project, and ask it for a video of your app: "make a 20 second demo of creating an invoice".',
  )
  return said
}

/** Gets the project ready, and says what it did and what's missing, for the agent to act on. */
export async function init(): Promise<string[]> {
  const said: string[] = []
  if (existsSync('.git') || existsSync('.gitignore')) {
    const ignore = existsSync('.gitignore') ? await readFile('.gitignore', 'utf8') : ''
    const lines = new Set(ignore.split('\n').map((line) => line.trim().replace(/\/$/, '')))
    const missing = ['.product-demo/', '.env'].filter((l) => !lines.has(l.replace(/\/$/, '')))
    if (missing.length > 0) {
      const gap = ignore && !ignore.endsWith('\n') ? '\n' : ''
      await appendFile('.gitignore', `${gap}${missing.join('\n')}\n`)
      said.push(`Added ${missing.join(' and ')} to .gitignore.`)
    }
  }
  await (await launchBrowser()).close()
  await findFfmpeg()
  said.push('Chromium and ffmpeg are ready.')

  const { voice } = await readConfig()
  const provider = PROVIDERS[voice.provider]
  const key = provider && process.env[provider.key]
  if (!provider) {
    said.push(`Voiceover: there's no provider called ${voice.provider}.`)
  } else if (!key) {
    said.push(
      `Voiceover: no ${provider.name} key, so films can't have a voiceover. Ask the user for one, ` +
        `once, and carry on meanwhile. They can save it in their own terminal with ` +
        `\`product-demo-agent-toolkit key ${voice.provider}\` (it asks for it, hidden). If they give it ` +
        `to you, pipe it in, so it stays out of the command line: ` +
        `\`printf %s '<key>' | product-demo-agent-toolkit key ${voice.provider}\`. Without one, make the film without a voiceover and say so.`,
    )
  } else {
    const problem = await provider.check(key)
    said.push(
      problem
        ? `Voiceover: the ${provider.name} key doesn't work (${problem}). Ask the user for a new one: ` +
            `\`product-demo-agent-toolkit key ${voice.provider}\` saves it.`
        : `Voiceover: ready, with ${provider.name}.`,
    )
  }
  return said
}

/** Checks a provider's key and saves it in ~/.product-demo/.env, for every project. */
export async function saveKey(id: string, key: string): Promise<string> {
  const provider: VoiceProvider | undefined = PROVIDERS[id]
  if (!provider) throw new Error(`No provider called ${id}. There's ${Object.keys(PROVIDERS)}.`)
  if (!key) throw new Error('No key given.')
  const problem = await provider.check(key)
  if (problem) throw new Error(`That ${provider.name} key doesn't work. ${problem}`)
  await mkdir(dirname(HOME_ENV), { recursive: true, mode: 0o700 })
  const old = existsSync(HOME_ENV) ? await readFile(HOME_ENV, 'utf8') : ''
  const kept = old.split('\n').filter((line) => line && !line.startsWith(`${provider.key}=`))
  // Readable only by the user, from the moment it's made (and if it was made before, from now).
  await writeFile(HOME_ENV, [...kept, `${provider.key}=${key}`].join('\n') + '\n', { mode: 0o600 })
  await chmod(HOME_ENV, 0o600)
  const shadowed =
    existsSync('.env') && (await readFile('.env', 'utf8')).includes(`${provider.key}=`)
  return `Saved the ${provider.name} key in ${HOME_ENV}, for every project.${
    shadowed ? ` This project's .env sets its own ${provider.key}, which is used here instead.` : ''
  }`
}

/** Reads a key without showing it: typed or pasted at a prompt, or piped in. */
export async function readSecret(question: string): Promise<string> {
  const input = process.stdin
  let text = ''
  if (!input.isTTY) {
    for await (const chunk of input) text += String(chunk)
    return text.trim()
  }
  process.stderr.write(question)
  input.setRawMode(true)
  try {
    for await (const chunk of input) {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') return text.trim()
        if (character === '\u0003') throw new Error('Cancelled.')
        if (character === '\u007f' || character === '\b') text = text.slice(0, -1)
        else text += character
      }
    }
  } finally {
    input.setRawMode(false)
    process.stderr.write('\n')
  }
  return text.trim()
}
