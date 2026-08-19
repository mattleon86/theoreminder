// Funzione serverless Vercel: salva/legge gli incarichi di Matteo Piano su un archivio condiviso
// (Vercel KV), così l'app può sincronizzarsi tra più dispositivi.
//
// Autenticazione semplice: la stessa password del lucchetto dell'app viene inviata in ogni
// richiesta nell'header "x-sync-key" e confrontata con la variabile d'ambiente SYNC_SECRET
// (impostata solo su Vercel, mai nel codice pubblico).
const { kv } = require('@vercel/kv');

const EVENTS_KEY = 'theoreminder:events';

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

  if (req.method === 'GET') {
    const events = (await kv.get(EVENTS_KEY)) || [];
    res.status(200).json({ events });
    return;
  }

  if (req.method === 'PUT') {
    const body = req.body || {};
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: 'Corpo della richiesta non valido: atteso { events: [...] }' });
      return;
    }
    await kv.set(EVENTS_KEY, body.events);
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: 'Metodo non consentito' });
};
