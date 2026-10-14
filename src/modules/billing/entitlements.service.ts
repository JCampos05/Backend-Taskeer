import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { EntitlementKey } from './entitlements.types';

/** Resuelve el planId "efectivo" contra el que se deben leer los
 * entitlements — normalmente Subscription.planId, salvo que esté dentro
 * del periodo de gracia de 24h tras una baja de plan
 * (downgradeGraceEndsAt en el futuro), en cuyo caso se usa el plan
 * anterior (más generoso). Se evalúa en el momento de la lectura, no
 * depende de que un job de limpieza ya haya corrido — ver
 * docs/08-planes-suscripciones.md. */
export function resolveEffectivePlanId(subscription: {
  planId: string;
  previousPlanId: string | null;
  downgradeGraceEndsAt: Date | null;
}): string {
  const enGracia =
    subscription.downgradeGraceEndsAt !== null &&
    subscription.downgradeGraceEndsAt.getTime() > Date.now();

  if (enGracia && subscription.previousPlanId) {
    return subscription.previousPlanId;
  }

  return subscription.planId;
}

/** Resuelve el valor efectivo de un entitlement para un usuario: primero
 * busca un override específico de su suscripción
 * (SubscriptionEntitlementOverride), y si no hay, cae al valor del plan
 * vigente (PlanEntitlement). Ningún límite/feature de plan se hardcodea en
 * el código — regla no negociable de CLAUDE.md — todo pasa por aquí. */
async function resolveEntitlement(userId: string, key: EntitlementKey): Promise<string> {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });

  if (!subscription) {
    // No debería pasar — todo User nace con Subscription en el registro
    // (ver Backend/src/modules/auth/auth.service.ts). Si ocurre, es un bug
    // de datos, no un caso de negocio a manejar con gracia.
    throw new AppError(500, 'SUBSCRIPTION_NOT_FOUND', 'No se pudo resolver tu plan.');
  }

  const override = await prisma.subscriptionEntitlementOverride.findUnique({
    where: { subscriptionId_key: { subscriptionId: subscription.id, key } },
  });

  if (override) {
    return override.value;
  }

  const planId = resolveEffectivePlanId(subscription);

  const entitlement = await prisma.planEntitlement.findUnique({
    where: { planId_key: { planId, key } },
  });

  if (!entitlement) {
    // Bug de seed/catálogo: todo plan activo debería tener todas las
    // claves del catálogo — ver Backend/prisma/plans-seed-data.ts.
    throw new AppError(
      500,
      'ENTITLEMENT_NOT_CONFIGURED',
      'No se pudo resolver un límite de tu plan.',
    );
  }

  return entitlement.value;
}

/** Azúcar sobre resolveEntitlement para "workspaces.owned.max": devuelve
 * un número, o `null` si el plan dice "unlimited". */
async function getWorkspacesOwnedMax(userId: string): Promise<number | null> {
  const valor = await resolveEntitlement(userId, 'workspaces.owned.max');
  if (valor === 'unlimited') return null;

  // Un valor mal formado (texto, vacío, decimal) NO debe leerse como
  // "ilimitado" — Number() daría NaN, que JSON serializa como null y el
  // consumidor interpretaría como sin límite (fallo abierto).
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 0) {
    throw new AppError(
      500,
      'ENTITLEMENT_NOT_CONFIGURED',
      'No se pudo resolver un límite de tu plan.',
    );
  }
  return numero;
}

/** Azúcar para claves booleanas ("true"/"false"). */
async function isEnabled(userId: string, key: EntitlementKey): Promise<boolean> {
  const valor = await resolveEntitlement(userId, key);
  return valor === 'true';
}

export const entitlementsService = {
  resolveEntitlement,
  getWorkspacesOwnedMax,
  isEnabled,
};
