import { z } from 'zod'

import { isFileSchema } from './File.js'

/** Converts a Zod schema to a JSON Schema object. Strips the `$schema` meta-property. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // z.custom() can't be converted to JSON Schema — strip file fields before conversion
  if (schema instanceof z.ZodObject) {
    const shape = { ...schema.shape } as Record<string, z.ZodType>
    const fileKeys: string[] = []
    for (const [key, field] of Object.entries(shape)) {
      if (isFileSchema(field)) {
        fileKeys.push(key)
        shape[key] = z.string().describe((field as any).description ?? 'File (binary)')
      }
    }
    if (fileKeys.length > 0) {
      const replaced = z.object(shape as z.ZodRawShape)
      const result = z.toJSONSchema(replaced) as Record<string, unknown>
      delete result.$schema
      // Restore file-specific schema metadata
      const props = result.properties as Record<string, Record<string, unknown>> | undefined
      if (props)
        for (const key of fileKeys) {
          if (props[key]) props[key].format = 'binary'
        }
      return result
    }
  }
  const result = z.toJSONSchema(schema) as Record<string, unknown>
  delete result.$schema
  return result
}
