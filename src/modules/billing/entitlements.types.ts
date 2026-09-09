// Claves conocidas del catálogo de docs/08-planes-suscripciones.md. String
// literal, no enum de Prisma — a propósito: agregar una clave nueva al
// catálogo es una decisión de negocio/documentación, no una migración de
// schema (PlanEntitlement.key es VarChar libre).
export type EntitlementKey =
  | 'storage.personal.enabled'
  | 'storage.shared.enabled'
  | 'workspaces.owned.max'
  | 'customization.level'
  | 'team.plus.enabled';
