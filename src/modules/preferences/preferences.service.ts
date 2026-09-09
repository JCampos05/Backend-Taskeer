import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { UpdatePreferencesInput } from './preferences.schema';
import type { UserPreferencesDto } from './preferences.types';

// Defaults tal como los define prisma/schema.prisma (model UserPreferences) —
// se repiten acá porque GET /me/preferences los devuelve incluso cuando la
// fila no existe todavía, sin crearla solo por leer (ver abajo).
const DEFAULT_THEME = 'AUTO' as const;
const DEFAULT_LANGUAGE = 'es';

function toPreferencesDto(preferences: {
  countryId: number | null;
  timezoneId: number | null;
  theme: UserPreferencesDto['theme'];
  language: string;
  updatedAt: Date;
}): UserPreferencesDto {
  return {
    countryId: preferences.countryId,
    timezoneId: preferences.timezoneId,
    theme: preferences.theme,
    language: preferences.language,
    isPersisted: true,
    updatedAt: preferences.updatedAt.toISOString(),
  };
}

/** GET /me/preferences. `UserPreferences` es nullable en `User` — a
 * diferencia de `Subscription`, no se crea una fila automáticamente al
 * registrarse (ver docs/02-modelo-datos.md). Si el usuario nunca guardó
 * nada, se devuelven los defaults del schema con `isPersisted: false` en vez
 * de un 404 — leer preferencias nunca debe fallar ni crear efectos
 * secundarios en la base de datos. */
async function getPreferences(userId: string): Promise<UserPreferencesDto> {
  const preferences = await prisma.userPreferences.findUnique({ where: { userId } });

  if (!preferences) {
    return {
      countryId: null,
      timezoneId: null,
      theme: DEFAULT_THEME,
      language: DEFAULT_LANGUAGE,
      isPersisted: false,
      updatedAt: null,
    };
  }

  return toPreferencesDto(preferences);
}

/** PATCH /me/preferences. País y zona horaria se seleccionan de catálogos
 * cerrados (`Country`/`Timezone`, ver GET /catalogs/countries y
 * /catalogs/timezones), nunca texto libre — si el id enviado no existe en el
 * catálogo, se responde un 400 claro en vez de dejar que la violación de FK
 * de Prisma (P2003) llegue cruda al error handler genérico. */
async function updatePreferences(
  userId: string,
  input: UpdatePreferencesInput,
): Promise<UserPreferencesDto> {
  if (input.countryId !== null && input.countryId !== undefined) {
    const country = await prisma.country.findUnique({ where: { id: input.countryId } });
    if (!country) {
      throw new AppError(400, 'INVALID_COUNTRY', 'El país seleccionado no es válido.');
    }
  }

  if (input.timezoneId !== null && input.timezoneId !== undefined) {
    const timezone = await prisma.timezone.findUnique({ where: { id: input.timezoneId } });
    if (!timezone) {
      throw new AppError(400, 'INVALID_TIMEZONE', 'La zona horaria seleccionada no es válida.');
    }
  }

  // Upsert: si no existe fila, se crea con los defaults del schema más lo
  // que venga en el body; si existe, se actualiza solo lo que venga
  // (spread de `input` — los campos ausentes quedan `undefined` y Prisma los
  // ignora en `update`/`create` en vez de sobreescribir con null).
  const preferences = await prisma.userPreferences.upsert({
    where: { userId },
    create: {
      userId,
      theme: input.theme ?? DEFAULT_THEME,
      language: input.language ?? DEFAULT_LANGUAGE,
      countryId: input.countryId ?? null,
      timezoneId: input.timezoneId ?? null,
    },
    update: {
      theme: input.theme,
      language: input.language,
      countryId: input.countryId,
      timezoneId: input.timezoneId,
    },
  });

  return toPreferencesDto(preferences);
}

export const preferencesService = {
  getPreferences,
  updatePreferences,
};
