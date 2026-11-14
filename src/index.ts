import pkg from '../package.json' with { type: 'json' }

export const version: string = pkg.version
export { readConfig, type Config } from './config.ts'
export { cut } from './cut.ts'
export { explore, send, serve } from './explore.ts'
export { readFilm, type Effect, type Film, type Step, type Target } from './film.ts'
export { record, type Footage } from './record.ts'
export { decide, fingerprint, rank, similarity, type Fingerprint } from './similo.ts'
