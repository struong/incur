import { z } from 'zod'

import { isFileSchema } from './File.js'

function replaceFileField(field: z.ZodType): z.ZodType {
  const wrappers: { type: string; value?: any }[] = []
  let current: any = field
  while (current) {
    const name = current.constructor.name
    if (name === 'ZodOptional') wrappers.push({ type: 'optional' })
    else if (name === 'ZodDefault') wrappers.push({ type: 'default', value: current._zod.def.defaultValue })
    else if (name === 'ZodNullable') wrappers.push({ type: 'nullable' })

    if (typeof current.meta === 'function' && current.meta()?.incurType === 'file') break
    current = current._zod?.def?.innerType
  }

  let replacement: any = z.string().describe((field as any).description ?? 'File (binary)')
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const w = wrappers[i]!
    if (w.type === 'optional') replacement = replacement.optional()
    else if (w.type === 'default') replacement = replacement.default(w.value)
    else if (w.type === 'nullable') replacement = replacement.nullable()
  }
  return replacement
}

/** Converts a Zod schema to a JSON Schema object. Strips the `$schema` meta-property. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // z.custom() can't be converted to JSON Schema — strip file fields before conversion
  if (schema instanceof z.ZodObject) {
    const shape = { ...schema.shape } as Record<string, z.ZodType>
    const fileKeys: string[] = []
    for (const [key, field] of Object.entries(shape)) {
      if (isFileSchema(field)) {
        fileKeys.push(key)
        shape[key] = replaceFileField(field)
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
