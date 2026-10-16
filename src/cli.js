#!/usr/bin/env node
// Usage: har-verify <capture.har> <client.ts>
// Exit codes: 0 no failures, 1 at least one fail, 2 usage or read/parse error.

import { readFileSync } from 'node:fs'
import { verify } from './verify.js'

const USAGE = 'usage: har-verify <capture.har> <client.ts>\n'

function main(argv) {
  const [harPath, clientPath, ...extra] = argv
  if (!harPath || !clientPath || extra.length > 0) {
    process.stderr.write(USAGE)
    return 2
  }

  let result
  try {
    const har = JSON.parse(readFileSync(harPath, 'utf8').replace(/^﻿/, ''))
    const client = readFileSync(clientPath, 'utf8')
    result = verify(har, client)
  } catch (error) {
    process.stderr.write(`har-verify: ${error.message}\n`)
    return 2
  }

  process.stdout.write(formatTable(result.checks) + '\n')
  const counts = { pass: 0, warn: 0, fail: 0 }
  for (const item of result.checks) counts[item.status] += 1
  process.stdout.write(`\n${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail\n`)
  return result.ok ? 0 : 1
}

function formatTable(checks) {
  const header = ['STATUS', 'METHOD', 'ENDPOINT', 'MESSAGE']
  const rows = checks.map((item) => [item.status, item.method, item.endpoint, item.message])
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)))
  const line = (cells) => cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]))).join('  ')
  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

process.exitCode = main(process.argv.slice(2))
