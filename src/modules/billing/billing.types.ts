// DTOs de solo lectura del módulo billing. Backend y Frontend no comparten
// paquete de tipos — el Frontend replica estos a mano en models/billing.ts.

export type SubscriptionStatusDto = 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';

/** Un plan del catálogo con sus entitlements tal cual están en BD (clave →
 * valor en texto: "true"/"false", un entero, o "unlimited"). Nada de esto se
 * hardcodea en el código — ver docs/08-planes-suscripciones.md. */
export interface PlanDto {
  code: string;
  name: string;
  description: string | null;
  /** null = sin precio fijo definido todavía (o precio personalizado). */
  priceMonthlyCents: number | null;
  isCustomPricing: boolean;
  entitlements: Record<string, string>;
}

/** Suscripción del usuario autenticado y su consumo actual. */
export interface MySubscriptionDto {
  /** Plan contratado (Subscription.planId). */
  planCode: string;
  planName: string;
  /** Plan contra el que se resuelven los límites ahora mismo: el anterior
   * mientras dure el periodo de gracia tras una baja, si no, el contratado. */
  effectivePlanCode: string;
  status: SubscriptionStatusDto;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  /** Solo si el periodo de gracia sigue vigente; si no, null. */
  downgradeGraceEndsAt: string | null;
  usage: {
    workspacesOwned: number;
    /** null = ilimitado. */
    workspacesOwnedMax: number | null;
  };
}
