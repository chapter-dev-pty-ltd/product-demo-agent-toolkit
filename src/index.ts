import pkg from '../package.json' with { type: 'json' }

export const version: string = pkg.version
export { lookToRaw, readConfig } from './config.ts'
export { cut, readFootage, videoLength } from './cut/cut.ts'
export { review } from './review.ts'
export {
  filesOf,
  findVideo,
  latestTake,
  listVideos,
  newRun,
  newVideo,
  type Video,
} from './videos.ts'
export { explore, exploreIn, send, serve } from './explore.ts'
export { readFilm } from './film.ts'
export {
  copySkills,
  init,
  installSkills,
  installedSkills,
  loadKeys,
  readSecret,
  saveKey,
  setup,
} from './setup.ts'
export { NeedsDecision, rehearse, shoot, type Footage } from './perform.ts'
export {
  openStudio,
  recentChat,
  sayInStudio,
  stopStudio,
  studio,
  waitForStudio,
  type StudioMessage,
} from './studio.ts'
export { speakLines, wordAt, type Spoken } from './voice.ts'
