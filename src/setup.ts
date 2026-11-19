import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { HOME } from './home.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pkg from '../package.json' with { type: 'json' }
import { readConfig } from './config.ts'
import { findFfmpeg, launchBrowser } from './tools.ts'
import { PROVIDERS, type VoiceProvider } from './voice.ts'

const HOME_ENV = join(HOME, '.env')

export function loadKeys(
  files: string[] = ['.env', HOME_ENV],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const keys = Object.values(PROVIDERS).map((provider) => provider.key)
  for (const file of files) {
    let found: Record<string, string | undefined>
    try {
      found = parseEnv(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const key of keys) {
      // Only a key that's there: process.env keeps undefined as the word "undefined", which
      // then counts as a key, is sent to the provider and is turned down.
      const value = found[key]
      if (value && !env[key]) env[key] = value
    }
  }
}

const COMMAND = 'product-demo-agent-toolkit'

const AGENTS: { name: string; home: string; skills?: string }[] = [
  { name: 'Claude Code', home: '.claude', skills: join('.claude', 'skills') },
  { name: 'Codex', home: '.codex', skills: join('.codex', 'skills') },
  {
    name: 'OpenCode',
    home: join('.config', 'opencode'),
    skills: join('.config', 'opencode', 'skills'),
  },
  { name: 'Cursor', home: '.cursor' },
  { name: 'Gemini CLI', home: '.gemini' },
  { name: 'GitHub Copilot', home: '.copilot' },
]

export async function copySkills(to: string): Promise<string> {
  await cp(fileURLToPath(new URL('../skills', import.meta.url)), to, { recursive: true })
  return to
}

export async function installSkills(
  home: string = homedir(),
): Promise<{ agents: string[]; folders: string[] }> {
  const found = AGENTS.filter((agent) => existsSync(join(home, agent.home)))
  const folders = [
    join(home, '.agents', 'skills'),
    ...found.flatMap((agent) => (agent.skills ? [join(home, agent.skills)] : [])),
  ]
  for (const folder of folders) await copySkills(folder)
  return { agents: found.map((agent) => agent.name), folders }
}

export function installedSkills({ agents }: { agents: string[] }): string {
  const named =
    agents.length > 1 ? `${agents.slice(0, -1).join(', ')} and ${agents.at(-1)}` : agents[0]
  return named
    ? `Installed the skills for ${named}, and in ~/.agents/skills for any other agent that reads it. For an agent that keeps skills somewhere else: ${COMMAND} skills <its skills folder>.`
    : `Installed the skills in ~/.agents/skills. If your agent keeps skills somewhere else: ${COMMAND} skills <its skills folder>.`
}

export async function setup(): Promise<string[]> {
  const said: string[] = []
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
  said.push(installedSkills(await installSkills()))
  said.push(
    'Ready. Start a new session with your agent in your project, and ask it for a video of your app: "make a 20 second demo of creating an invoice".',
  )
  return said
}

export async function init(): Promise<string[]> {
  const said: string[] = []
  if (existsSync('.git') || existsSync('.gitignore')) {
    const ignore = existsSync('.gitignore') ? await readFile('.gitignore', 'utf8') : ''
    const lines = new Set(ignore.split('\n').map((line) => line.trim().replace(/\/$/, '')))
    const missing = ['.env'].filter((l) => !lines.has(l.replace(/\/$/, '')))
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
      `Voiceover: no ${provider.name} key, so films can't have a voiceover. ` +
        askForKey(voice.provider, 'one'),
    )
  } else {
    const problem = await provider.check(key)
    said.push(
      problem
        ? `Voiceover: the ${provider.name} key doesn't work (${problem}), so films can't have ` +
            `a voiceover. ${askForKey(voice.provider, 'a new one')}`
        : `Voiceover: ready, with ${provider.name}.`,
    )
  }
  return said
}

function askForKey(provider: string, which: 'one' | 'a new one'): string {
  return (
    `A voiceover is optional: ask the user for ${which}, once, and carry on meanwhile. They can ` +
    `save it in their own terminal with \`${COMMAND} key ${provider}\` (it asks for it, hidden). ` +
    `If they give it to you, pipe it in, so it stays out of the command line: ` +
    `\`printf %s '<key>' | ${COMMAND} key ${provider}\`. Without one, make the film without a ` +
    `voiceover and say so.`
  )
}

export async function saveKey(id: string, key: string): Promise<string> {
  const provider: VoiceProvider | undefined = PROVIDERS[id]
  if (!provider) throw new Error(`No provider called ${id}. There's ${Object.keys(PROVIDERS)}.`)
  if (!key) throw new Error('No key given.')
  const problem = await provider.check(key)
  if (problem) throw new Error(`That ${provider.name} key doesn't work. ${problem}`)
  await mkdir(dirname(HOME_ENV), { recursive: true, mode: 0o700 })
  const old = existsSync(HOME_ENV) ? await readFile(HOME_ENV, 'utf8') : ''
  const kept = old.split('\n').filter((line) => line && !line.startsWith(`${provider.key}=`))
  await writeFile(HOME_ENV, [...kept, `${provider.key}=${key}`].join('\n') + '\n', { mode: 0o600 })
  await chmod(HOME_ENV, 0o600)
  const shadowed =
    existsSync('.env') && Boolean(parseEnv(await readFile('.env', 'utf8'))[provider.key])
  return `Saved the ${provider.name} key in ${HOME_ENV}, for every project.${
    shadowed ? ` This project's .env sets its own ${provider.key}, which is used here instead.` : ''
  }`
}

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
