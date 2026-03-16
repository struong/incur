# Plan: `z.file()` and `c.raw()` for incur

## Motivation

incur CLIs that process binary files (images, audio, PDFs) can't use `cli.fetch` as a unified API because:
1. **Input**: `cli.fetch` only parses JSON bodies — no multipart/form-data or binary uploads
2. **Output**: `cli.fetch` always wraps responses in a JSON envelope — no raw binary responses

This forces developers to maintain a parallel HTTP server (e.g., Hono) alongside the incur CLI, duplicating parameter parsing, validation, and business logic.

Two new features fix this:
- **`z.file()`** — a schema type representing file input, interpreted per transport
- **`c.raw()`** — a context method to return raw binary responses

## Oracle Review Decisions

1. **z.file() detection**: Use `z.custom<FileValue>().meta({ incurType: 'file' })` with a shared `isFileSchema()` helper that walks `innerType` chain to find the meta. Do NOT use brands or subclassing.

2. **coerce() stays sync**: Use `readFileSync` for CLI path arguments. Stdin fallback handled separately in async `runCommand()` flow.

3. **HTTP input parsing**: Build one flat `input` record from query/body/form, then split by schema keys in `executeCommand()` — reuse `splitParams()` pattern from Mcp.ts. For `application/octet-stream`, only support when command has exactly one `z.file()` field.

4. **MCP base64**: Use `Buffer.from(bytes).toString('base64')` and `new Uint8Array(Buffer.from(value, 'base64'))` — no `btoa`/`String.fromCharCode`.

5. **c.raw() follows sentinel pattern exactly**: Tagged with `[sentinel]: 'raw'`, returns `never`, placed alongside `OkResult`/`ErrorResult` in Cli.ts.

6. **Typegen.ts fix**: Change `z.toJSONSchema(schema)` to use `Schema.toJsonSchema()` so file types get proper schema output.

7. **v1 scope limits**: No `c.raw()` in streaming handlers (async generators). No `Openapi.ts` reverse mapping. No multi-file stdin.

8. **Export API**: `export const z = Object.assign(baseZ, { file })` in index.ts so users write `z.file()`.

## Feature 1: `z.file()`

### Semantics

A Zod type that represents a file. Each transport interprets it differently:

| Transport | Input | `c.args.image` value |
|-----------|-------|---------------------|
| **CLI** | `plate photo.png` (file path) | `{ bytes: Uint8Array, name: 'photo.png' }` |
| **CLI stdin** | `cat photo.png \| plate` | `{ bytes: Uint8Array }` |
| **HTTP** | multipart `image=@file` or `application/octet-stream` body | `{ bytes: Uint8Array, name: 'photo.png' }` |
| **MCP** | base64-encoded string | `{ bytes: Uint8Array }` |

### Usage

```ts
import { Cli, z } from 'incur'

Cli.create('plate', {
  args: z.object({
    image: z.file().describe('Image to process'),
  }),
  run(c) {
    c.args.image.bytes   // Uint8Array
    c.args.image.name    // string | undefined
  },
})
```

### Implementation

#### 1. Define the `z.file()` type — new file `src/File.ts`

Create a custom Zod type or a branded wrapper. The simplest approach: use `z.custom<FileValue>()` with a branded symbol, so `unwrap()` and type checks can identify it.

```ts
export const fileSymbol = Symbol.for('incur.file')

export type FileValue = {
  bytes: Uint8Array
  name?: string
}

export function file() {
  return z.custom<FileValue>((val) => {
    if (typeof val === 'object' && val !== null && 'bytes' in val) {
      return val.bytes instanceof Uint8Array
    }
    return false
  }).brand(fileSymbol)
}

export function isFileSchema(schema: unknown): boolean {
  // Check if the unwrapped schema has the file brand/symbol
  // Implementation depends on how Zod v4 exposes brands
}
```

**Alternative**: if Zod v4 brands are hard to detect in `unwrap()`, use a wrapper class:

```ts
export class ZodFile extends z.ZodType<FileValue> { ... }
```

Pick whichever is easier to detect in `coerce()` / `resolveTypeName()` / `buildToolSchema()`.

#### 2. Export from `src/index.ts`

Add `file` to the `z` re-export or export a separate `file` function. Preferred: augment the `z` namespace so users write `z.file()`.

```ts
// src/index.ts
import { file } from './File.js'
export { z, file }
// OR augment z: (z as any).file = file
```

#### 3. `src/Parser.ts` — CLI argv coercion

In `coerce()` (~L251), add a branch for the file type:

```ts
// After: if (typeName === 'ZodBoolean' ...) return ...
if (isFileSchema(inner) && typeof value === 'string') {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const bytes = new Uint8Array(fs.readFileSync(value))
  return { bytes, name: path.basename(value) }
}
```

**Note**: `coerce()` is currently synchronous. File reading with `readFileSync` keeps it sync. If async is preferred, `coerce()` needs to become async — check all call sites in `Parser.parse()`.

Also handle stdin: if the file arg is omitted and stdin is not a TTY, read from stdin. This may belong in the CLI `runCommand()` flow rather than `coerce()`.

#### 4. `src/Cli.ts` — HTTP body parsing in `fetchImpl()`

In `fetchImpl()` (~L1510), add multipart/form-data and octet-stream handling:

```ts
let inputOptions: Record<string, unknown> = {}
let fileFields: Record<string, FileValue> = {}

if (req.method === 'GET') {
  for (const [key, value] of url.searchParams) inputOptions[key] = value
} else {
  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData()
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        fileFields[key] = {
          bytes: new Uint8Array(await value.arrayBuffer()),
          name: value.name,
        }
      } else {
        inputOptions[key] = value
      }
    }
  } else if (contentType.includes('application/octet-stream')) {
    // Single file upload — assign to the first z.file() arg
    const bytes = new Uint8Array(await req.arrayBuffer())
    // Need to identify which arg is z.file() from the command schema
    const fileArgName = findFileArg(command)
    if (fileArgName) fileFields[fileArgName] = { bytes }
  } else if (contentType.includes('application/json')) {
    inputOptions = (await req.json()) as Record<string, unknown>
  }
}
```

Then merge `fileFields` into the args before passing to `command.run()`.

Similar changes needed in `executeCommand()` (~L1578).

#### 5. `src/Mcp.ts` — base64 decoding in `callTool()`

In `callTool()` (~L55), after `splitParams()`, detect file-typed params and decode:

```ts
for (const [key, value] of Object.entries(args)) {
  if (isFileSchema(command.args?.shape?.[key]) && typeof value === 'string') {
    args[key] = {
      bytes: Uint8Array.from(atob(value), c => c.charCodeAt(0)),
      name: undefined,
    }
  }
}
```

In `buildToolSchema()` (~L164), emit `{ type: 'string', contentEncoding: 'base64', description: '...' }` for file fields.

#### 6. `src/Help.ts` — display type name

In `resolveTypeName()` (~L270), add:

```ts
if (isFileSchema(unwrapped)) return 'file'
```

#### 7. `src/Schema.ts` — JSON Schema output

`toJsonSchema()` delegates to `z.toJSONSchema()`. If the custom type doesn't produce a useful schema, add a post-processing step:

```ts
// Detect file fields and override their schema
if (isFileSchema(field)) {
  return { type: 'string', format: 'binary', description: field.description }
}
```

#### 8. `src/Typegen.ts` — TypeScript type generation

In `resolveType()` (~L59), add:

```ts
if (isFileSchema(schema)) return '{ bytes: Uint8Array; name?: string }'
```

---

## Feature 2: `c.raw()`

### Semantics

A context method that returns a raw `Response` from `run()`, bypassing the JSON envelope.

| Transport | Behavior |
|-----------|----------|
| **CLI** | Write binary body to stdout (or `-o file`). No TOON/JSON formatting. |
| **HTTP** | Return `Response` as-is with the specified content-type and status. |
| **MCP** | Return body as base64-encoded text content (MCP can't do binary). |

### Usage

```ts
run(c) {
  const pngBuffer = processImage(c.args.image.bytes)
  return c.raw(pngBuffer, { contentType: 'image/png' })

  // Or with full Response options:
  return c.raw(pngBuffer, { contentType: 'image/png', status: 200, headers: { 'X-Custom': 'val' } })
}
```

### Implementation

#### 1. Define the `RawResult` sentinel — `src/Cli.ts`

Add alongside `OkResult` and `ErrorResult` (~L2096):

```ts
type RawResult = {
  [sentinel]: 'raw'
  body: Uint8Array | string
  contentType: string
  status: number
  headers: Record<string, string>
}
```

Update `isSentinel()` (~L2154):

```ts
function isSentinel(value: unknown): value is OkResult | ErrorResult | RawResult {
  return typeof value === 'object' && value !== null && sentinel in value
}
```

#### 2. Add `raw()` to the context — `src/Cli.ts`

In `runCommand()` (~L1221) and `executeCommand()` (~L1597), add the `raw` function alongside `ok` and `error`:

```ts
const rawFn = (
  body: Uint8Array | string,
  opts: { contentType: string; status?: number; headers?: Record<string, string> } 
): never => {
  return {
    [sentinel]: 'raw',
    body,
    contentType: opts.contentType,
    status: opts.status ?? 200,
    headers: opts.headers ?? {},
  } as never
}

const result = command.run({
  // ...existing fields...
  raw: rawFn,
})
```

#### 3. Handle `RawResult` in CLI output — `src/Cli.ts` `serveImpl()` `runCommand()`

In the result handling block (~L1269), add a branch before the existing `ok`/`error` checks:

```ts
if (isSentinel(awaited) && awaited[sentinel] === 'raw') {
  const raw = awaited as RawResult
  if (outputPath) {
    // -o flag: write to file
    const fs = await import('node:fs')
    fs.writeFileSync(outputPath, raw.body)
  } else {
    // Write binary to stdout
    process.stdout.write(raw.body)
  }
  return  // Skip formatting/envelope entirely
}
```

#### 4. Handle `RawResult` in HTTP response — `src/Cli.ts` `executeCommand()`

In the non-streaming result handling (~L1697), add a branch:

```ts
if (sentinel_ in awaited && (awaited as any)[sentinel_] === 'raw') {
  const raw = awaited as any
  return new Response(raw.body, {
    status: raw.status,
    headers: {
      'content-type': raw.contentType,
      ...raw.headers,
    },
  })
}
```

#### 5. Handle `RawResult` in MCP — `src/Mcp.ts` `callTool()`

MCP can't return binary directly. Convert to base64:

```ts
if (sentinel in awaited && (awaited as any)[sentinel] === 'raw') {
  const raw = awaited as any
  const body = raw.body instanceof Uint8Array
    ? btoa(String.fromCharCode(...raw.body))
    : raw.body
  return {
    content: [{ type: 'text', text: body }],
  }
}
```

#### 6. Type updates — `src/Cli.ts` command definition types

Update the `run()` context type (~L2687) to include `raw`:

```ts
raw: (body: Uint8Array | string, opts: {
  contentType: string
  status?: number
  headers?: Record<string, string>
}) => never
```

---

## Testing

### `z.file()` tests

Add to `src/Parser.test.ts`:
- `test('coerces file path to FileValue')` — verify `coerce()` reads a temp file and returns `{ bytes, name }`

Add to `src/Cli.test.ts`:
- `test('cli.fetch parses multipart/form-data with file field')` — POST with FormData containing a File, verify `run()` receives `FileValue`
- `test('cli.fetch parses application/octet-stream body')` — POST with raw body
- `test('cli handles file arg from argv')` — run CLI with a file path arg

Add to `src/Mcp.test.ts`:
- `test('callTool decodes base64 file param')` — verify base64 string → `FileValue`

Add to `src/Help.test.ts`:
- `test('resolveTypeName returns file for z.file()')` — verify help display

### `c.raw()` tests

Add to `src/Cli.test.ts`:
- `test('cli.fetch returns raw Response for c.raw()')` — verify HTTP response bypasses JSON envelope, has correct content-type and body
- `test('cli writes raw body to stdout')` — verify CLI mode writes binary without formatting

Add to `src/Mcp.test.ts`:
- `test('callTool returns base64 for c.raw()')` — verify MCP fallback

Add to `src/e2e.test.ts`:
- End-to-end test: define a command with `z.file()` arg and `c.raw()` return, test via CLI argv and `cli.fetch`

---

## File Change Summary

| File | `z.file()` | `c.raw()` | Change Type |
|------|-----------|----------|-------------|
| `src/File.ts` | ✅ | — | **New file** — `z.file()` type definition, `isFileSchema()` helper |
| `src/index.ts` | ✅ | — | Export `file` / augment `z` |
| `src/Parser.ts` | ✅ | — | Add file coercion branch in `coerce()` |
| `src/Cli.ts` | ✅ | ✅ | HTTP body parsing (multipart/octet-stream), `RawResult` sentinel, `raw()` context fn, result handling in both CLI and HTTP paths |
| `src/Mcp.ts` | ✅ | ✅ | Base64 decode in `callTool()`, base64 encode for raw results, schema for file fields in `buildToolSchema()` |
| `src/Help.ts` | ✅ | — | `resolveTypeName()` → `'file'` |
| `src/Schema.ts` | ✅ | — | JSON Schema for file type (`format: 'binary'`) |
| `src/Typegen.ts` | ✅ | — | TS type for file (`{ bytes: Uint8Array; name?: string }`) |
| `src/Openapi.ts` | ✅ | — | `format: 'binary'` → `z.file()` |
| `src/Skill.ts` | ✅ | — | File type display in skill docs |

## Suggested Implementation Order

1. **`c.raw()`** — smaller surface area, fewer files, can test immediately with existing CLI commands
2. **`z.file()`** — larger scope, depends on understanding the type detection pattern used for `c.raw()` sentinel

Within each:
1. Define the type/sentinel
2. Wire up CLI path (easiest to test)
3. Wire up HTTP path (`cli.fetch`)
4. Wire up MCP path
5. Update help/schema/typegen
6. Tests
