import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const HOME: string = process.env.PRODUCT_DEMO_HOME
  ? resolve(process.env.PRODUCT_DEMO_HOME)
  : join(homedir(), '.product-demo')
