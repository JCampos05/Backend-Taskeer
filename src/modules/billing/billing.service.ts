import { prisma } from '../../config/prisma';
import { AppError } from '../../errors/AppError';
import type { MySubscriptionDto, PlanDto } from './billing.types';
import { entitlementsService, resolveEffectivePlanId } from './entitlements.service';

/** Catálogo público de planes activos, ordenado. Solo lectura. */
async function listPlans(): Promise<PlanDto[]> {
  const plans = await prisma.plan.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: { entitlements: true },
  });

  return plans.map((plan) => ({
    code: plan.code,
    name: plan.name,
    description: plan.description,
    priceMonthlyCents: plan.priceMonthlyCents,
    isCustomPricing: plan.isCustomPricing,
    entitlements: Object.fromEntries(plan.entitlements.map((e) => [e.key, e.value])),
  }));
}

/** Suscripción del usuario autenticado + consumo. El límite de workspaces se
 * resuelve por el resolver de entitlements (override de la suscripción o plan
 * efectivo), nunca comparando códigos de plan. */
async function getMySubscription(userId: string): Promise<MySubscriptionDto> {
  const subscription = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true, previousPlan: true },
  });

  if (!subscription) {
    throw new AppError(500, 'SUBSCRIPTION_NOT_FOUND', 'No se pudo resolver tu plan.');
  }

  // Misma regla de gracia que usa el resolver de entitlements (una sola
  // fuente), para que `effectivePlanCode` nunca difiera del plan contra el
  // que realmente se resuelven los límites.
  const effectivePlanId = resolveEffectivePlanId(subscription);
  const enGracia = effectivePlanId !== subscription.planId;

  const [workspacesOwned, workspacesOwnedMax] = await Promise.all([
    prisma.workspace.count({ where: { ownerId: userId, deletedAt: null } }),
    entitlementsService.getWorkspacesOwnedMax(userId),
  ]);

  return {
    planCode: subscription.plan.code,
    planName: subscription.plan.name,
    effectivePlanCode:
      enGracia && subscription.previousPlan ? subscription.previousPlan.code : subscription.plan.code,
    status: subscription.status,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    canceledAt: subscription.canceledAt?.toISOString() ?? null,
    downgradeGraceEndsAt:
      enGracia && subscription.downgradeGraceEndsAt
        ? subscription.downgradeGraceEndsAt.toISOString()
        : null,
    usage: { workspacesOwned, workspacesOwnedMax },
  };
}

export const billingService = {
  listPlans,
  getMySubscription,
};
