import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { verify } from '../src/verify.js'

const here = dirname(fileURLToPath(import.meta.url))
const cliPath = join(here, '..', 'src', 'cli.js')
const harPath = join(here, '..', 'fixtures', 'notes.har')
const clientPath = join(here, '..', 'fixtures', 'notes-client.ts')

const har = JSON.parse(readFileSync(harPath, 'utf8'))
const client = readFileSync(clientPath, 'utf8')

function replaceOnce(source, from, to) {
  assert.ok(source.includes(from), `fixture text not found: ${from}`)
  return source.replace(from, to)
}

function failures(result) {
  return result.checks.filter((item) => item.status === 'fail')
}

test('passing case: every recorded API call matches the client', () => {
  const result = verify(har, client)
  assert.equal(result.ok, true, JSON.stringify(failures(result)))
  assert.equal(failures(result).length, 0)

  const endpoints = result.checks.map((item) => `${item.method} ${item.endpoint}`)
  assert.ok(endpoints.includes('GET /api/notes'))
  assert.ok(endpoints.includes('POST /api/notes'))
  assert.ok(endpoints.includes('GET /api/notes/{id}'), 'numeric path segment matches a client path parameter')
  assert.ok(!endpoints.some((item) => item.includes('app.js')), 'static assets are ignored')
})

test('missing endpoint fails', () => {
  const broken = replaceOnce(client, '`/api/notes/${', '`/api/item/${')
  const result = verify(har, broken)
  assert.equal(result.ok, false)
  const failed = failures(result)
  assert.equal(failed.length, 1)
  assert.equal(failed[0].method, 'GET')
  assert.equal(failed[0].endpoint, '/api/notes/{id}')
})

test('missing response key fails', () => {
  const broken = replaceOnce(
    client,
    'export type GetNoteResponse = { id: number; title: string; updatedAt?: string }',
    'export type GetNoteResponse = { id: number; updatedAt?: string }',
  )
  const result = verify(har, broken)
  assert.equal(result.ok, false)
  const failed = failures(result)
  assert.equal(failed.length, 1)
  assert.match(failed[0].message, /"title"/)
  assert.equal(failed[0].endpoint, '/api/notes/{id}')
})

test('extra optional response key only warns', () => {
  const extended = replaceOnce(
    client,
    'export type GetNoteResponse = { id: number; title: string; updatedAt?: string }',
    'export type GetNoteResponse = { id: number; title: string; updatedAt?: string; tags?: string[] }',
  )
  const result = verify(har, extended)
  assert.equal(result.ok, true)
  const warnings = result.checks.filter((item) => item.status === 'warn' && /tags/.test(item.message))
  assert.equal(warnings.length, 1)
})

test('extra required response key fails', () => {
  const extended = replaceOnce(
    client,
    'export type GetNoteResponse = { id: number; title: string; updatedAt?: string }',
    'export type GetNoteResponse = { id: number; title: string; updatedAt?: string; owner: string }',
  )
  const result = verify(har, extended)
  assert.equal(result.ok, false)
  assert.match(failures(result)[0].message, /"owner"/)
})

test('HAR with no API calls warns and passes', () => {
  const empty = { log: { entries: [har.log.entries[0]] } }
  const result = verify(empty, client)
  assert.equal(result.ok, true)
  assert.equal(result.checks[0].status, 'warn')
})

test('CLI exits 0 when the client matches', () => {
  const run = spawnSync(process.execPath, [cliPath, harPath, clientPath], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /STATUS\s+METHOD\s+ENDPOINT/)
  assert.match(run.stdout, /pass\s+GET\s+\/api\/notes\/\{id\}/)
})

test('CLI exits 1 when a check fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'har-verify-'))
  try {
    const brokenPath = join(dir, 'broken-client.ts')
    writeFileSync(brokenPath, replaceOnce(client, '`/api/notes/${', '`/api/item/${'))
    const run = spawnSync(process.execPath, [cliPath, harPath, brokenPath], { encoding: 'utf8' })
    assert.equal(run.status, 1, run.stderr)
    assert.match(run.stdout, /fail\s+GET\s+\/api\/notes\/\{id\}/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI exits 2 on usage error', () => {
  const run = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stderr, /usage: har-verify/)
})
