import pkg from '../package.json' with { type: 'json' }

export const version: string = pkg.version
export { CONFIG_FILE, lookToRaw, readConfig } from './config.ts'
export { cut, prepare, readFootage, videoLength } from './cut/cut.ts'
export { clearPlan, planEdit, shownEdits, writePlan } from './cut/edits.ts'
export { review } from './review.ts'
export {
  filesOf,
  findVideo,
  latestTake,
  listVideos,
  newRun,
  newVideo,
  pruneRuns,
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
} from './studio-server.ts'
export { speakLines, wordAt, type Spoken } from './voice.ts'
