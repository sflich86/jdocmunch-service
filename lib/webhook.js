/**
 * @file webhook.js
 * @description Notificador seguro VPS -> Vercel (Front).
 * Firma los payloads con HMAC-SHA256 para asegurar que solo la VPS pueda
 * actualizar el estado de los libros en el frontend.
 */

const crypto = require('crypto');
require('dotenv').config();

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const VERCEL_WEBHOOK_URL = process.env.VERCEL_WEBHOOK_URL;

/**
 * Notifica a Vercel sobre el cambio de estado de un libro.
 * 
 * @param {string} bookId 
 * @param {'COMPLETE' | 'ERROR'} status 
 * @param {Object} [extra={}] 
 */
async function notifyVercel(bookId, status, extra = {}) {
  if (!WEBHOOK_SECRET || !VERCEL_WEBHOOK_URL) {
    console.warn('[Webhook] WEBHOOK_SECRET o VERCEL_WEBHOOK_URL no configurados. Saltando notificación.');
    return;
  }

  const payload = { 
    bookId, 
    status, 
    timestamp: Date.now(),
    ...extra
  };

  const payloadString = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payloadString)
    .digest('hex');

  try {
    const res = await fetch(VERCEL_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature
      },
      body: payloadString
    });

    if (!res.ok) {
      console.warn(`[Webhook] Vercel respondió con status ${res.status}`);
    } else {
      console.log(`[Webhook] ✅ Notificación enviada a Vercel para ${bookId}: ${status}`);
    }
  } catch (error) {
    // El fallo del webhook no debe romper el proceso de la VPS, 
    // ya que el frontend tiene el polling como backup.
    console.warn('[Webhook] Error intentando notificar a Vercel:', error.message);
  }
}

module.exports = { notifyVercel };
