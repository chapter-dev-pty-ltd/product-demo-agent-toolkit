import pkg from '../package.json' with { type: 'json' }

export const version: string = pkg.version
export { BACKDROPS, readConfig, type Config } from './config.ts'
export { cut } from './cut.ts'
export { latestRun, newRun, type Kind } from './footage.ts'
export { explore, send, serve } from './explore.ts'
export { readFilm, type Outcome, type Film, type Step, type Target } from './film.ts'
export {
  NeedsDecision,
  rehearse,
  shoot,
  VIEWPORT,
  type Footage,
  type Rehearsal,
} from './perform.ts'
export { decide, fingerprint, rank, similarity, type Fingerprint } from './similo.ts'
