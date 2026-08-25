// Funzione serverless Vercel: salva/rimuove le sottoscrizioni Web Push del dispositivo, così il
// cron job (api/send-reminders.js) sa a chi inviare le notifiche quando l'app non è aperta.
// Stessa autenticazione semplice delle altre API (vedi api/events.js).
const { kv } = require('@vercel/kv');

const SUBS_KEY = 'theoreminder:push-subscriptions';

function isAuthorized(req) {
  const provided = req.headers['x-sync-key'];
  const expected = process.env.SYNC_SECRET;
  return !!expected && provided === expected;
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Non autorizzato' });
    return;
  }

  if (req.method === 'POST') {
    const { subscription } = req.body || {};
    if (!subscription || !subscription.endpoint) {
      res.status(400).json({ error: 'Corpo della richiesta non valido: atteso { subscription }' });
      return;
    }
    const subs = (await kv.get(SUBS_KEY)) || [];
    // Rimuove un'eventuale sottoscrizione precedente con lo stesso endpoint prima di riaggiungerla,
    // così un dispositivo che si ri-registra non finisce duplicato nella lista.
    const deduped = subs.filter((s) => s.endpoint !== subscription.endpoint);
    deduped.push(subscription);
    await kv.set(SUBS_KEY, deduped);
    res.status(200).json({ ok: true });
    return;
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      res.status(400).json({ error: 'Corpo della richiesta non valido: atteso { endpoint }' });
      return;
    }
    const subs = (await kv.get(SUBS_KEY)) || [];
    await kv.set(SUBS_KEY, subs.filter((s) => s.endpoint !== endpoint));
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Metodo non consentito' });
};
