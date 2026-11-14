import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { chromium, type Browser } from 'playwright-core'

/** Launches Playwright's Chromium, downloading it first if this machine has never had it. */
export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch()
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error
    console.error('Downloading Chromium (once)…')
    const cli = join(
      dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')),
      'cli.js',
    )
    await run(process.execPath, [cli, 'install', 'chromium-headless-shell'])
    return chromium.launch()
  }
}

// ffmpeg 6.1.1 from github.com/eugeneware/ffmpeg-static, by platform, with each download's sha256.
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1'
const FFMPEG_BUILDS: Record<string, string> = {
  'darwin-arm64': '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
  'darwin-x64': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'linux-arm64': '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
  'linux-x64': 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
  'win32-x64': '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
}

/** An ffmpeg that can write H.264: $PRODUCT_DEMO_FFMPEG, the one on PATH, or our own, downloaded once. */
export async function findFfmpeg(): Promise<string> {
  const chosen = process.env.PRODUCT_DEMO_FFMPEG
  if (chosen) return chosen
  if (await writesH264('ffmpeg')) return 'ffmpeg'

  const build = `${process.platform}-${process.arch}`
  const own = join(
    homedir(),
    '.cache',
    'product-demo',
    `ffmpeg-6.1.1${process.platform === 'win32' ? '.exe' : ''}`,
  )
  if (existsSync(own)) return own

  const sha256 = FFMPEG_BUILDS[build]
  if (!sha256) {
    throw new Error(
      `No ffmpeg download for ${build}. Install ffmpeg, or set PRODUCT_DEMO_FFMPEG to one.`,
    )
  }
  console.error('Downloading ffmpeg (once)…')
  const response = await fetch(`${FFMPEG_RELEASE}/ffmpeg-${build}.gz`)
  if (!response.ok)
    throw new Error(`Could not download ffmpeg: ${response.status} ${response.statusText}`)
  const gz = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(gz).digest('hex') !== sha256) {
    throw new Error('The ffmpeg download did not match its checksum, so it was not used.')
  }
  await mkdir(dirname(own), { recursive: true })
  await writeFile(`${own}.part`, gunzipSync(gz))
  await chmod(`${own}.part`, 0o755)
  await rename(`${own}.part`, own)
  return own
}

async function writesH264(ffmpeg: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk))
    child.on('error', () => done(false))
    child.on('exit', () => done(out.includes('libx264')))
  })
}

export function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', fail)
    child.on('exit', (code) =>
      code === 0 ? done() : fail(new Error(`${command} failed with code ${code}.`)),
    )
  })
}
