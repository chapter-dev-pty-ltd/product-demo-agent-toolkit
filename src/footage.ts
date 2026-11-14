import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

// Each recording gets its own folder, named for its film and when it was made, so a new
// one never replaces an old one. Each film keeps its last `keep` recordings.

const DIR = join('.product-demo', 'footage')

/** A new folder for a recording of `filmPath`, after deleting that film's oldest beyond `keep`. */
export async function newFootage(filmPath: string, keep: number): Promise<string> {
  const film = basename(filmPath, extname(filmPath))
  const now = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  await mkdir(DIR, { recursive: true })
  const older = (await readdir(DIR))
    .filter((name) => name.startsWith(`${film}-`) && /\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d$/.test(name))
    .sort()
  for (const name of older.slice(0, Math.max(0, older.length - (keep - 1)))) {
    await rm(join(DIR, name), { recursive: true, force: true })
  }
  return join(DIR, `${film}-${stamp}`)
}

/** The most recent recording of any film. */
export async function latestFootage(): Promise<string> {
  const names = await readdir(DIR).catch(() => [])
  const dated = await Promise.all(
    names.map(async (name) => ({ name, at: (await stat(join(DIR, name))).mtimeMs })),
  )
  const newest = dated.sort((a, b) => b.at - a.at)[0]
  if (!newest) throw new Error('No footage yet. Record a film first: product-demo record film.json')
  return join(DIR, newest.name)
}
