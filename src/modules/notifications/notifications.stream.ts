import { randomBytes, createHash } from 'node:crypto';
import type { Response } from 'express';
import type { Notification } from '@prisma/client';

/**
 * Entrega en vivo de notificaciones vía Server-Sent Events —
 * `GET /notifications/stream`. Reemplaza al WebSocket original (ver
 * docs/01-arquitectura.md) porque el canal siempre fue unidireccional
 * (servidor → cliente, nunca al revés) y SSE es HTTP normal: hereda el
 * `cors()` de Express automáticamente, no necesita un `verifyClient` a
 * mano como sí hacía falta con el handshake de WebSocket.
 *
 * Diseño de seguridad — por qué un ticket y no el JWT en la URL:
 * `EventSource` no puede mandar headers custom, así que la autenticación
 * no puede ir como `Authorization: Bearer` — tiene que ir en la URL de
 * alguna forma. Poner el JWT de acceso ahí (como hacía el WebSocket)
 * expone un credential reutilizable por hasta ~15 minutos (su TTL) en
 * cualquier lugar donde la URL quede registrada — logs de proxies
 * intermedios fuera de nuestro control, historial del navegador, headers
 * Referer. En vez de eso: el cliente pide un "ticket" corto y opaco por
 * `POST /notifications/stream-ticket` (esa sí va con el JWT real, pero por
 * header, como cualquier otra request autenticada normal). El ticket:
 *   - Vive 30 segundos — si no se usa para abrir el stream en ese tiempo,
 *     ya no sirve para nada.
 *   - Es de un solo uso — se borra del mapa en el instante en que se
 *     consume, antes de aceptar la conexión SSE. Interceptarlo después de
 *     que el legítimo ya lo usó no sirve de nada.
 *   - Solo sirve para abrir ESTE stream de solo lectura — a diferencia de
 *     un JWT robado, no da acceso a ningún otro endpoint de la API.
 * Solo se guarda el HASH del ticket en memoria, nunca el valor en claro —
 * mismo criterio que AuthToken/RefreshToken/RecoveryCode en la base de
 * datos, aplicado acá a un store en memoria.
 *
 * Limitación conocida (igual que ya aceptamos para el worker in-process,
 * ver docs/01-arquitectura.md): los Maps de abajo son locales a este
 * proceso. Con una sola instancia de API (cierto hoy) no hay problema; si
 * algún día hay más de una instancia detrás de un balanceador, un ticket
 * emitido por la instancia A no lo reconocería la instancia B — en ese
 * momento hay que mover esto a un store compartido (Redis), no antes.
 */

const TICKET_TTL_MS = 30_000;
const CONEXION_MAX_DURACION_MS = 20 * 60 * 1000; // 20 min — más corto que
// un JWT robado indefinidamente reutilizable, obliga a re-ticketear
// periódicamente aunque la conexión nunca se haya caído sola.
const MAX_CONEXIONES_POR_USUARIO = 5;
const INTERVALO_HEARTBEAT_MS = 20_000;

interface TicketInfo {
  userId: string;
  expiresAt: number;
}

const ticketsPendientes = new Map<string, TicketInfo>();
const conexionesPorUsuario = new Map<string, Set<Response>>();

function hashTicket(ticketPlain: string): string {
  return createHash('sha256').update(ticketPlain).digest('hex');
}

/** Genera un ticket de un solo uso para `userId`. Se llama desde una ruta
 * ya protegida por `requireAuth` — nunca acepta un userId del cliente. */
export function issueStreamTicket(userId: string): string {
  const ticketPlain = randomBytes(32).toString('hex');
  ticketsPendientes.set(hashTicket(ticketPlain), {
    userId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticketPlain;
}

/** Consume un ticket: si es válido y no vencido, lo borra y devuelve el
 * userId asociado. Cualquier otro caso (no existe, vencido, ya usado)
 * devuelve `null` — el llamador nunca debe distinguir el motivo exacto en
 * la respuesta al cliente (mismo principio de no revelar detalle interno
 * que ya aplica en el resto de la API). */
export function consumeStreamTicket(ticketPlain: string): string | null {
  const hash = hashTicket(ticketPlain);
  const info = ticketsPendientes.get(hash);

  // Se borra siempre que se encuentra, válido o no — un ticket vencido no
  // debe quedar reutilizable ni acumulándose en el mapa.
  if (info) ticketsPendientes.delete(hash);

  if (!info || info.expiresAt < Date.now()) {
    return null;
  }

  return info.userId;
}

// Barrido periódico de tickets vencidos que nunca se llegaron a usar (ej.
// el cliente pidió uno y se cerró la pestaña antes de conectar el stream)
// — sin esto quedarían en el Map para siempre, una fuga de memoria lenta
// pero real a lo largo de mucho tiempo de actividad del proceso.
setInterval(() => {
  const ahora = Date.now();
  for (const [hash, info] of ticketsPendientes) {
    if (info.expiresAt < ahora) ticketsPendientes.delete(hash);
  }
}, 60_000);

function agregarConexion(userId: string, res: Response): void {
  let existentes = conexionesPorUsuario.get(userId);
  if (!existentes) {
    existentes = new Set();
    conexionesPorUsuario.set(userId, existentes);
  }

  // Tope de conexiones simultáneas: si ya alcanzó el máximo, cierra la más
  // vieja para hacer espacio en vez de rechazar la nueva — un usuario con
  // muchas pestañas legítimas no debería quedar bloqueado, pero tampoco
  // debe poder acumular conexiones sin límite (fuga de memoria/file
  // descriptors en un proceso con recursos acotados, como el free tier de
  // Render).
  if (existentes.size >= MAX_CONEXIONES_POR_USUARIO) {
    const masVieja = existentes.values().next().value;
    if (masVieja) {
      masVieja.end();
      existentes.delete(masVieja);
    }
  }

  existentes.add(res);
}

function quitarConexion(userId: string, res: Response): void {
  const existentes = conexionesPorUsuario.get(userId);
  if (!existentes) return;
  existentes.delete(res);
  if (existentes.size === 0) {
    conexionesPorUsuario.delete(userId);
  }
}

function escribirEvento(res: Response, evento: string, data: unknown): void {
  res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Abre el stream SSE para `userId` sobre una respuesta Express ya
 * validada (el ticket se consumió antes de llamar a esto, en el
 * controller). Se llama una vez por conexión. */
export function openStream(userId: string, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx (y proxies similares) bufferean respuestas por default,
    // rompiendo la entrega incremental de SSE — este header lo desactiva
    // específicamente para esta respuesta.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Comentario de apertura: no es un evento real, solo fuerza el primer
  // flush de bytes para que el cliente confirme la conexión de inmediato.
  res.write(': conectado\n\n');

  agregarConexion(userId, res);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, INTERVALO_HEARTBEAT_MS);

  // Tiempo de vida máximo: pase lo que pase, esta conexión no queda viva
  // para siempre — al vencer, se avisa al cliente con un evento propio
  // (`reauth`) para que pida un ticket nuevo y reconecte de inmediato, en
  // vez de tratarlo como una caída de red.
  const limiteDuracion = setTimeout(() => {
    escribirEvento(res, 'reauth', {});
    res.end();
  }, CONEXION_MAX_DURACION_MS);

  const limpiar = () => {
    clearInterval(heartbeat);
    clearTimeout(limiteDuracion);
    quitarConexion(userId, res);
  };

  res.on('close', limpiar);
  res.on('error', limpiar);
}

/** Empuja un payload en vivo a todas las conexiones activas de un usuario.
 * Si no tiene ninguna, no hace nada — la fuente de verdad siempre es
 * `Notification` en la base de datos, esto es solo la entrega en vivo
 * cuando aplica (ver docs/01-arquitectura.md). */
export function pushToUser(userId: string, evento: string, data: unknown): void {
  const conexiones = conexionesPorUsuario.get(userId);
  if (!conexiones) return;

  for (const res of conexiones) {
    escribirEvento(res, evento, data);
  }
}

/** Empuja una fila de `Notification` ya creada al dueño, en el formato que
 * espera el frontend. Reutilizada por cualquier módulo que cree una
 * Notification y quiera entregarla en vivo (auth, workspaces, el worker de
 * recordatorios). */
export function pushNotification(notification: Notification): void {
  pushToUser(notification.userId, 'notification', {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    taskId: notification.taskId,
    readAt: null,
    createdAt: notification.createdAt.toISOString(),
  });
}
