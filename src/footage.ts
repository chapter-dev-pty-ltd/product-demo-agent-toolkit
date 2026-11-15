import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

// Each rehearsal and each shoot gets its own folder, named for its film and when it ran,
// so a new run never replaces an old one. Each film keeps its last `keep` of each.

export type Kind = 'rehearsals' | 'footage'

const dirOf = (kind: Kind) => join('.product-demo', kind)

/** A new folder for a run of `filmPath`, after deleting that film's oldest beyond `keep`. */
export async function newRun(kind: Kind, filmPath: string, keep: number): Promise<string> {
  const film = basename(filmPath, extname(filmPath))
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  await mkdir(dirOf(kind), { recursive: true })
  const older = (await readdir(dirOf(kind)))
    .filter((name) => name.startsWith(`${film}-`) && /\d{4}(-\d\d){5}(-\d+)?$/.test(name))
    .sort()
  for (const name of older.slice(0, Math.max(0, older.length - (keep - 1)))) {
    await rm(join(dirOf(kind), name), { recursive: true, force: true })
  }
  // Two runs in the same second (a shoot and its retry) get their own folders.
  let dir = join(dirOf(kind), `${film}-${stamp}`)
  for (let n = 2; older.includes(basename(dir)); n++)
    dir = join(dirOf(kind), `${film}-${stamp}-${n}`)
  return dir
}

/** The most recent run of any film that finished (so has `finished`, like footage.json, in it). */
export async function latestRun(kind: Kind, finished: string): Promise<string> {
  const all = await readdir(dirOf(kind)).catch(() => [])
  const names = all.filter((name) => existsSync(join(dirOf(kind), name, finished)))
  const dated = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(join(dirOf(kind), name))).mtimeMs })),
  )
  const newest = dated.sort((a, b) => b.at - a.at)[0]
  if (!newest) throw new Error(`No finished ${kind} yet.`)
  return join(dirOf(kind), newest.name)
}
