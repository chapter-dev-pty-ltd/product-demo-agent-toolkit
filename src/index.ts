import pkg from '../package.json' with { type: 'json' }

export const version: string = pkg.version
export { readFilm, type Film, type Step, type Target } from './film.ts'
export { record, type Footage } from './record.ts'
export { cut } from './cut.ts'
