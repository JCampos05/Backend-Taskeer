// DTOs propios del módulo preferences. El Backend no comparte paquete de
// tipos con el Frontend por ahora — cada uno define los suyos (ver
// docs/01-arquitectura.md).

export type InterfaceThemeDto = 'LIGHT' | 'DARK' | 'AUTO';

// Mismo shape tanto si la fila ya existe en `UserPreferences` como si es un
// default que todavía no se persistió — `isPersisted` es la única señal que
// distingue ambos casos (ver GET /me/preferences en preferences.service.ts).
export interface UserPreferencesDto {
  countryId: number | null;
  timezoneId: number | null;
  theme: InterfaceThemeDto;
  language: string;
  // false cuando el usuario nunca guardó nada todavía y esto son los
  // defaults del schema sin persistir — el frontend puede usarlo para, por
  // ejemplo, no mostrar "última actualización" o distinguir "nunca configuró
  // esto" de "configuró explícitamente los valores por defecto".
  isPersisted: boolean;
  updatedAt: string | null;
}
