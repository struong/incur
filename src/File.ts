import { z } from 'zod'

/** The runtime value for a file argument. */
export type FileValue = {
  bytes: Uint8Array
  name?: string | undefined
}

/** Creates a Zod schema representing a file input. Per transport: CLI reads from disk path, HTTP from multipart/form-data, MCP from base64. */
export function file() {
  return z
    .custom<FileValue>((value): value is FileValue => {
      return (
        typeof value === 'object' &&
        value !== null &&
        (value as any).bytes instanceof Uint8Array &&
        ((value as any).name === undefined || typeof (value as any).name === 'string')
      )
    })
    .meta({ incurType: 'file' })
}

/** Checks whether a Zod schema (including wrapped forms) represents a file type. */
export function isFileSchema(schema: unknown): boolean {
  let current: any = schema
  while (current) {
    if (typeof current.meta === 'function' && current.meta()?.incurType === 'file') return true
    current = current._zod?.def?.innerType ?? current._zod?.def?.element
  }
  return false
}
