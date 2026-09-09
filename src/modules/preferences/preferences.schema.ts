import { z } from 'zod';

// Todo body/params/query se valida con Zod antes de tocar la base de datos —
// ver docs/03-autenticacion-seguridad.md, sección "Validación de entrada".

// countryId/timezoneId: null explícito es válido ("quitar" la selección,
// ambos son nullable en el schema de Prisma); undefined (campo ausente en el
// body) significa "no tocar este campo" — el PATCH solo actualiza lo que
// venga. `.nullable().optional()` en vez de `.nullish()` para dejar esa
// distinción explícita en la lectura del schema.
export const updatePreferencesSchema = z.object({
  body: z.object({
    theme: z.enum(['LIGHT', 'DARK', 'AUTO']).optional(),
    language: z
      .string()
      .trim()
      .toLowerCase()
      .length(2, 'El idioma debe ser un código ISO 639-1 de 2 letras.')
      .optional(),
    countryId: z.number().int().positive().nullable().optional(),
    timezoneId: z.number().int().positive().nullable().optional(),
  }),
});

export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>['body'];
