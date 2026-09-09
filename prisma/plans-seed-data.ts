// Catálogo inicial de planes y sus entitlements — editable libremente, esto
// es data, no código de negocio. Cambiar un valor aquí y volver a correr el
// seed es la forma normal de ajustar límites, no una migración de schema.
//
// Convención de valor: "true"/"false" para flags booleanos, un entero como
// string para límites numéricos, "unlimited" como sentinela de "sin límite".
// El significado de cada clave está documentado en
// docs/08-planes-suscripciones.md — mantenerlo sincronizado si se agrega una
// clave nueva.

export const plans = [
  {
    code: 'FREE',
    name: 'Free',
    description: 'Uso personal completo, sin archivos y con espacios compartidos limitados.',
    priceMonthlyCents: 0,
    isCustomPricing: false,
    sortOrder: 1,
    entitlements: {
      'storage.personal.enabled': 'false',
      'storage.shared.enabled': 'false',
      'workspaces.owned.max': '3',
      'customization.level': 'basic',
    },
  },
  {
    code: 'PRO',
    name: 'Pro',
    description: 'Archivos y fotos habilitados, personalización avanzada, más espacios compartidos.',
    priceMonthlyCents: null, // pendiente de definir precio
    isCustomPricing: false,
    sortOrder: 2,
    entitlements: {
      'storage.personal.enabled': 'true',
      'storage.shared.enabled': 'true',
      'workspaces.owned.max': '10',
      'customization.level': 'advanced',
    },
  },
  {
    code: 'TEAM',
    name: 'Team',
    description: 'Archivos, fotos, personalización y espacios compartidos ilimitados, pensado para equipos grandes.',
    priceMonthlyCents: null, // pendiente de definir precio
    isCustomPricing: false,
    sortOrder: 3,
    entitlements: {
      'storage.personal.enabled': 'true',
      'storage.shared.enabled': 'true',
      'workspaces.owned.max': 'unlimited',
      'customization.level': 'advanced',
      // Placeholder: el usuario mencionó "un plus especial para equipo
      // amplio" sin especificar todavía qué es exactamente. Esta clave
      // existe para no perder el requisito — falta definir su significado
      // real antes de que el código dependa de ella.
      'team.plus.enabled': 'true',
    },
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description: 'Precio y funciones personalizadas por cliente.',
    priceMonthlyCents: null,
    isCustomPricing: true,
    sortOrder: 4,
    // Punto de partida — para Business, lo normal es que cada cliente termine
    // con SubscriptionEntitlementOverride propios encima de esta base.
    entitlements: {
      'storage.personal.enabled': 'true',
      'storage.shared.enabled': 'true',
      'workspaces.owned.max': 'unlimited',
      'customization.level': 'advanced',
      'team.plus.enabled': 'true',
    },
  },
];
