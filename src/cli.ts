#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { version } from './index.ts'

const { values } = parseArgs({
  options: { version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } },
  allowPositionals: true,
})

if (values.version) {
  console.log(version)
} else {
  console.log(`product-demo ${version}\n\nUsage: product-demo <command>\n\nNo commands yet.`)
}
