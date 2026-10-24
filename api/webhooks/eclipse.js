import { createHmac, timingSafeEqual } from 'node:crypto';

// EclipsePay signs: timestamp + '.' + eventId + '.' + raw request body.
// This endpoint validates events and activates the webhook. It does NOT mark
// orders paid based solely on an incoming notification; charge-status.js
// independently checks the charge against the provider before delivery.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  const secret = process.env.ECLIPSE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook não configurado' });
  try {
    const id = req.headers['x-eclipse-event-id'];
    const timestamp = req.headers['x-eclipse-timestamp'];
    const signature = req.headers['x-eclipse-signature'];
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) ||
        typeof timestamp !== 'string' || !/^\d{10,11}$/.test(timestamp) ||
        typeof signature !== 'string' || !/^v1=[0-9a-f]{64}$/i.test(signature)) {
      return res.status(401).json({ error: 'Cabeçalhos inválidos' });
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return res.status(401).json({ error: 'Timestamp expirado' });
    }
    // Vercel's Node runtime may parse JSON by default; disable bodyParser in config.
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) return res.status(413).json({ error: 'Corpo muito grande' });
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${id}.`).update(rawBody).digest();
    const supplied = Buffer.from(signature.slice(3), 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); }
    catch { return res.status(400).json({ error: 'JSON inválido' }); }
    if (event?.id !== id) return res.status(401).json({ error: 'ID do evento divergente' });
    if (event.type === 'webhook.endpoint_verification') {
      if (typeof event.data?.challenge !== 'string') return res.status(400).json({ error: 'Desafio inválido' });
      return res.status(200).json({ challenge: event.data.challenge });
    }
    // No automatic payment confirmation from uncorrelated events.
    // Client's authenticated charge-status endpoint verifies the charge and amount.
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Eclipse webhook handler error:', error?.message);
    return res.status(500).json({ error: 'Falha no processamento do webhook' });
  }
}

export const config = { api: { bodyParser: false } };
