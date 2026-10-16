// har-verify: a static check that a generated typed API client still matches
// the API calls recorded in a HAR capture. No network, no dependencies.
// See README.md for how matching works and what it does not prove.

const STATIC_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|woff2?|ttf|eot|mp4|webm)$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_TYPE_DEPTH = 4

/**
 * @param {object | string} har Parsed HAR document, or its JSON text.
 * @param {string} generatedClientSource Source text of the generated client.
 * @returns {{ ok: boolean, checks: Array<{ endpoint: string, method: string, status: 'pass' | 'fail' | 'warn', message: string }> }}
 */
export function verify(har, generatedClientSource) {
  const source = String(generatedClientSource ?? '')
  const functions = clientFunctions(source)
  const calls = uniqueCalls(recordedCalls(har))
  const checks = []

  if (calls.length === 0) {
    checks.push(check('(none)', '-', 'warn', 'no API calls found in HAR'))
    return finish(checks)
  }

  for (const call of calls) {
    const fn = functions.find(
      (candidate) =>
        candidate.method === call.method &&
        candidate.segments !== null &&
        segmentsMatch(candidate.segments, call.segments),
    )
    if (!fn) {
      checks.push(check(call.endpoint, call.method, 'fail', `no generated function calls ${call.method} ${call.endpoint}`))
      continue
    }

    const shownPath = '/' + fn.segments.join('/')
    checks.push(check(call.endpoint, call.method, 'pass', `${fn.name} calls ${call.method} ${shownPath}`))

    if (call.status >= 400) {
      checks.push(check(call.endpoint, call.method, 'warn', `recorded status ${call.status}; response fields not compared`))
    } else if (!call.hasJson) {
      checks.push(check(call.endpoint, call.method, 'warn', 'no JSON response body recorded; response fields not compared'))
    } else if (!fn.responseType) {
      checks.push(check(call.endpoint, call.method, 'warn', `${fn.name} has no Promise<T> return type; response fields not compared`))
    } else {
      for (const item of compareResponse(source, fn.responseType, call.json)) {
        checks.push(check(call.endpoint, call.method, item.status, item.message))
      }
    }
  }
  return finish(checks)
}

function check(endpoint, method, status, message) {
  return { endpoint, method, status, message }
}

function finish(checks) {
  return { ok: !checks.some((item) => item.status === 'fail'), checks }
}

// ---------------------------------------------------------------- HAR side

function recordedCalls(har) {
  const doc = typeof har === 'string' ? JSON.parse(har.replace(/^﻿/, '')) : har
  const entries = doc?.log?.entries ?? doc?.entries
  if (!Array.isArray(entries)) throw new Error('HAR is missing log.entries')
  return entries.map(toRecordedCall).filter(Boolean)
}

// Same API-like filter as flowshot's parse-har: xhr/fetch, JSON in either
// direction, or a path containing /api/. Static assets are dropped unless xhr/fetch.
function toRecordedCall(entry) {
  const request = entry?.request
  if (!request?.url) return null
  let url
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  const method = String(request.method ?? 'GET').toUpperCase()
  if (method === 'OPTIONS' || method === 'HEAD') return null

  const resource = String(entry._resourceType ?? '').toLowerCase()
  const responseMime = String(entry.response?.content?.mimeType ?? '')
  const requestMime = String(request.postData?.mimeType ?? '')
  const apiLike =
    resource === 'xhr' ||
    resource === 'fetch' ||
    responseMime.includes('json') ||
    requestMime.includes('json') ||
    url.pathname.includes('/api/')
  if (!apiLike) return null
  if (STATIC_EXT.test(url.pathname) && resource !== 'xhr' && resource !== 'fetch') return null

  const segments = url.pathname.split('/').filter(Boolean)
  return {
    method,
    segments,
    endpoint: '/' + segments.map((segment) => (/^\d+$/.test(segment) || UUID.test(segment) ? '{id}' : segment)).join('/'),
    status: entry.response?.status ?? 0,
    ...responseBody(entry.response?.content),
  }
}

function responseBody(content) {
  if (typeof content?.text !== 'string' || content.text === '') return { hasJson: false }
  const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text
  const trimmed = text.trim()
  const jsonLike = String(content.mimeType ?? '').includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!jsonLike) return { hasJson: false }
  try {
    return { hasJson: true, json: JSON.parse(trimmed) }
  } catch {
    return { hasJson: false }
  }
}

// One check per method + normalized endpoint; a successful JSON sample wins.
function uniqueCalls(calls) {
  const byKey = new Map()
  for (const call of calls) {
    const key = `${call.method} ${call.endpoint}`
    const previous = byKey.get(key)
    if (!previous || (!isGoodSample(previous) && isGoodSample(call))) byKey.set(key, call)
  }
  return [...byKey.values()]
}

function isGoodSample(call) {
  return call.hasJson && call.status < 400
}

// ------------------------------------------------------------- client side

// Finds `export function name(` and `export const name = (` declarations and
// reads each one's body up to the next such declaration.
function clientFunctions(source) {
  const starts = [
    ...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/g),
  ]
  return starts.map((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : source.length
    const body = source.slice(match.index, end)
    const path = clientPathOf(body)
    return {
      name: match[1] ?? match[2],
      method: (/method:\s*["'](\w+)["']/.exec(body)?.[1] ?? 'GET').toUpperCase(),
      path,
      segments: path === null ? null : clientSegments(path),
      responseType: /\)\s*:\s*Promise<\s*([\w$.]+)\s*>/.exec(body)?.[1] ?? null,
    }
  })
}

// The first argument of `new URL(...)` or `fetch(...)` when it is a plain
// string or template literal.
function clientPathOf(body) {
  const match =
    /new\s+URL\(\s*(["'`])([^"'`]*)\1/.exec(body) ?? /fetch\(\s*(["'`])([^"'`]*)\1/.exec(body)
  return match ? match[2] : null
}

// Template expressions, `{param}` and `:param` segments become `*` wildcards.
function clientSegments(path) {
  let working = path
  if (/^https?:\/\//.test(working)) {
    try {
      working = new URL(working).pathname
    } catch {
      return null
    }
  }
  return working
    .replace(/[?#].*$/, '')
    .replace(/\$\{[^}]*\}/g, '*')
    .split('/')
    .filter(Boolean)
    .map((segment) => (/^\{[^}]*\}$/.test(segment) || /^:\w+$/.test(segment) ? '*' : segment))
}

function segmentsMatch(pattern, recorded) {
  if (pattern.length !== recorded.length) return false
  return pattern.every((segment, index) => segmentMatches(segment, recorded[index]))
}

function segmentMatches(pattern, value) {
  if (pattern === value) return true
  if (!pattern.includes('*')) return false
  const regex = new RegExp('^' + pattern.split('*').map(escapeRegex).join('[^/]+') + '$')
  return regex.test(value)
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ------------------------------------------------------------ type walking

// Returns the top-level result for comparing a recorded JSON body against a type.
function compareResponse(source, typeName, json) {
  const shape = shapeOf(source, typeName, 0)
  if (shape.kind === 'unknown') {
    return [{ status: 'warn', message: `${typeName} not compared: ${shape.note}` }]
  }

  const recordedIsArray = Array.isArray(json)
  if ((shape.kind === 'array') !== recordedIsArray) {
    const clientSays = shape.kind === 'array' ? 'an array' : 'an object'
    const recordingSays = recordedIsArray ? 'an array' : 'an object'
    return [{ status: 'fail', message: `${typeName} is ${clientSays} but the recording returned ${recordingSays}` }]
  }

  let object = shape
  if (shape.kind === 'array') {
    if (shape.element.kind !== 'object') {
      return [{ status: 'warn', message: `${typeName} element is not an object type; not compared` }]
    }
    object = shape.element
  }

  const samples = (recordedIsArray ? json : [json]).filter(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  )
  if (samples.length === 0) {
    return [{ status: 'warn', message: 'recording has no object fields to compare (empty array or primitive)' }]
  }

  const recordedKeys = new Set(samples.flatMap((sample) => Object.keys(sample)))
  const results = []
  for (const key of recordedKeys) {
    if (!object.members.some((member) => member.name === key)) {
      results.push({ status: 'fail', message: `response key "${key}" is in the recording but not in ${typeName}` })
    }
  }
  for (const member of object.members) {
    if (recordedKeys.has(member.name)) continue
    results.push(
      member.optional
        ? { status: 'warn', message: `optional field "${member.name}" in ${typeName} not seen in the recording` }
        : { status: 'fail', message: `required field "${member.name}" in ${typeName} is not in the recording` },
    )
  }
  if (results.length === 0) results.push({ status: 'pass', message: `response keys match ${typeName}` })
  return results
}

// Reduces a type expression to { kind: 'object', members } | { kind: 'array', element }
// | { kind: 'unknown', note }. Named aliases are resolved within the same source.
function shapeOf(source, text, depth) {
  const type = text.trim()
  if (depth > MAX_TYPE_DEPTH) return { kind: 'unknown', note: 'type nesting too deep' }
  if (splitTopLevel(type, ['|', '&']).length > 1) {
    return { kind: 'unknown', note: 'union and intersection types are not compared' }
  }
  if (/^[A-Za-z_$][\w$]*$/.test(type)) {
    const declared = declaredType(source, type)
    if (declared === null) return { kind: 'unknown', note: `${type} is not declared in the client` }
    return shapeOf(source, declared, depth + 1)
  }
  const generic = /^Array<([\s\S]*)>$/.exec(type)
  if (generic) return { kind: 'array', element: shapeOf(source, generic[1], depth + 1) }
  if (type.endsWith('[]')) return { kind: 'array', element: shapeOf(source, type.slice(0, -2), depth + 1) }
  if (type.startsWith('{') && type.endsWith('}')) {
    return { kind: 'object', members: parseMembers(type.slice(1, -1)) }
  }
  return { kind: 'unknown', note: `unsupported type: ${type.slice(0, 40)}` }
}

// Body of `type NAME = ...`, read up to a top-level `;` or newline.
function declaredType(source, name) {
  const match = new RegExp(`(?:export\\s+)?type\\s+${escapeRegex(name)}\\s*=`).exec(source)
  if (!match) return null
  const start = match.index + match[0].length
  let depth = 0
  let index = start
  for (; index < source.length; index++) {
    const ch = source[index]
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++
    else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && source[index - 1] !== '=')) {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (ch === ';' || ch === '\n')) break
  }
  return source.slice(start, index).trim()
}

// Top-level members of an object type: `name: T`, `name?: T`, quoted names allowed.
// Index signatures and methods are skipped.
function parseMembers(body) {
  return splitTopLevel(body.replace(/\/\/[^\n]*/g, ''), [';', ',', '\n'])
    .map((part) => /^\s*(["']?)([A-Za-z_$][\w$-]*)\1(\?)?\s*:/.exec(part))
    .filter(Boolean)
    .map((match) => ({ name: match[2], optional: match[3] === '?' }))
}

function splitTopLevel(text, separators) {
  const parts = []
  let depth = 0
  let current = ''
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++
    else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && text[index - 1] !== '=')) {
      depth = Math.max(0, depth - 1)
    }
    if (depth === 0 && separators.includes(ch)) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}
