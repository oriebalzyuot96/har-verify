# har-verify

Checks that a typed API client generated from a HAR capture (for example by Flowshot) still matches the API calls recorded in that capture.

Zero dependencies, Node 24+, ESM, no network access.

## Usage

```sh
node src/cli.js capture.har client.ts
# or, after npm link / npm install -g: har-verify capture.har client.ts
```

The CLI prints a table of checks and a summary line. Exit codes:

- `0`: no failures (warnings are allowed)
- `1`: at least one check failed
- `2`: usage error, or the HAR or client file could not be read or parsed

Programmatic use:

```js
import { verify } from './src/verify.js'
const { ok, checks } = verify(harObjectOrJsonText, clientSource)
```

## How it works

1. **Recorded calls.** Every entry in `log.entries` is kept if it looks like an API call: resource type `xhr` or `fetch`, a JSON response or request body, or a path containing `/api/`. OPTIONS and HEAD are ignored, and static assets are dropped unless they were xhr/fetch. Calls are deduplicated by method and normalized path, where numeric and UUID segments display as `{id}`. A successful JSON sample is preferred when a call was recorded more than once.

2. **Client functions.** Each `export function name(` and `export const name = (` in the client is read up to the next such export. Its method comes from `method: "..."` (default `GET`). Its path is the first string or template literal passed to `new URL(...)` or `fetch(...)`. Template expressions (`${...}`), `{param}` and `:param` segments are wildcards, and a recorded segment matches any value in that position.

3. **Endpoint check.** A recorded call passes if some client function has the same method and a matching path. Otherwise it fails.

4. **Response check.** The function's `Promise<T>` return type is resolved to a type alias declared in the same file. The top-level keys of the recorded JSON are compared with that type's top-level fields. For array responses, the keys of all object elements are combined.
   - A recorded key missing from the type: **fail**.
   - A required field missing from the recording: **fail**.
   - An optional field missing from the recording: **warn**.
   - 4xx/5xx responses, non-JSON bodies, and types that cannot be read (unions, intersections, generics, undeclared names): **warn**, not compared.

Checks are returned as `{ endpoint, method, status: 'pass' | 'fail' | 'warn', message }`.

## Limits

- **Static matching only.** The client is never run and the server is never called. This is not a runtime or contract test.
- **Regex parsing, not a TypeScript parser.** The client is read with simple scanning. Paths must be string or template literals in the first argument of `new URL` or `fetch`. Arrow functions must be written `export const f = (` or `= async (`.
- **Top-level keys only.** Nested object shapes, nested arrays and value types are not compared.
- **One capture is partial evidence.** A required field that the capture happens not to include fails the check, and an endpoint the capture did not exercise is not checked at all. Clients can therefore fail on a capture that is incomplete rather than on a real API change.
- **Request side is not checked.** Query parameters, request bodies and headers are ignored.
- **Single client file.** Only the file passed on the command line is read; imported types from other files are not resolved.

## Tests

```sh
npm test
```

Fixtures live in `fixtures/`. CI runs `npm test` on every push (`.github/workflows/verify.yml`).
