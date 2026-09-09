import { Resend } from 'resend';
import { env } from '../../config/env';

// Servicio de correo aislado — auth.service.ts (y cualquier otro módulo)
// nunca debe hablarle a Resend directo, para poder cambiar de proveedor sin
// tocar lógica de negocio (ver docs/03-autenticacion-seguridad.md).
//
// Mientras no haya RESEND_API_KEY configurado (todavía no existe cuenta de
// Resend creada), el envío se degrada a un log de servidor en vez de
// fallar — nunca debe bloquear un flujo de negocio (registro, reset de
// contraseña) solo porque el correo no salió.

const resendClient = env.resendApiKey ? new Resend(env.resendApiKey) : null;

interface SendMailInput {
  to: string;
  subject: string;
  html: string;
}

async function send(input: SendMailInput): Promise<void> {
  if (!resendClient) {
    console.log(`[mail] RESEND_API_KEY no configurado — correo no enviado. To: ${input.to} Subject: ${input.subject}`);
    return;
  }

  try {
    // El SDK de Resend NO lanza excepción en errores a nivel de API (dominio
    // no autorizado, from inválido, etc.) — devuelve { data, error } sin
    // tirar. Solo lanza en fallos de red/transporte. Hay que chequear
    // `error` explícitamente o un rechazo de la API pasa silencioso.
    const { error } = await resendClient.emails.send({
      from: env.resendFromEmail,
      to: input.to,
      subject: input.subject,
      html: input.html,
    });

    if (error) {
      console.error(`[mail] Resend rechazó el envío a ${input.to}: ${error.message}`);
    }
  } catch (err) {
    // No relanzar: un fallo de envío no debe tumbar el flujo de negocio que
    // lo disparó (registro, forgot-password, etc.). Solo el mensaje, nunca
    // el objeto de error completo — algunos SDKs de HTTP adjuntan el
    // payload de la request fallida, que aquí incluiría el token de un solo
    // uso en el `html` del correo.
    const message = err instanceof Error ? err.message : 'error desconocido';
    console.error(`[mail] Falló el envío a ${input.to}: ${message}`);
  }
}

// Escapa entidades HTML antes de interpolar cualquier dato de usuario (no
// solo el token, que siempre es hex controlado) en el HTML de un correo —
// sin esto, un nombre de workspace con `<script>` u otra marca queda
// embebido tal cual en el correo enviado.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendVerificationEmail(to: string, verificationToken: string): Promise<void> {
  const verifyUrl = `${env.publicWebUrl}/verificar-correo?token=${verificationToken}`;
  return send({
    to,
    subject: 'Verifica tu correo en Taskeer',
    html: `<p>Confirma tu correo para empezar a usar Taskeer:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Este enlace vence en 24 horas.</p>`,
  });
}

function sendWorkspaceInvitationEmail(
  to: string,
  invitationToken: string,
  workspaceName: string,
): Promise<void> {
  const acceptUrl = `${env.publicWebUrl}/invitaciones/aceptar?token=${invitationToken}`;
  // El nombre del workspace lo elige el usuario (hasta 150 caracteres, sin
  // restricción de contenido más allá de longitud) — nunca interpolarlo sin
  // escapar en el subject/html de un correo saliente.
  const safeName = escapeHtml(workspaceName);
  return send({
    to,
    subject: `Te invitaron al workspace "${safeName}" en Taskeer`,
    html: `<p>Te invitaron a unirte al workspace <strong>${safeName}</strong> en Taskeer.</p><p><a href="${acceptUrl}">${acceptUrl}</a></p><p>Si todavía no tienes cuenta, primero regístrate con este mismo correo y luego vuelve a abrir este enlace. Este enlace vence en 72 horas.</p>`,
  });
}

export const mailService = {
  sendVerificationEmail,
  sendWorkspaceInvitationEmail,
};
