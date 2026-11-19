import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Everything the toolkit keeps lives in one folder in the user's home, not in their
// projects: the default look, the voice cache, saved keys and every video.
// PRODUCT_DEMO_HOME moves it, for tests or a second set of videos.

export const HOME: string = process.env.PRODUCT_DEMO_HOME
  ? resolve(process.env.PRODUCT_DEMO_HOME)
  : join(homedir(), '.product-demo')
