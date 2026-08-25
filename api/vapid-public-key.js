// Funzione serverless Vercel: restituisce la chiave pubblica VAPID che il client usa per
// sottoscriversi alle notifiche Web Push. Non è un segreto in senso stretto (le chiavi pubbliche
// VAPID sono per definizione condivisibili), ma richiediamo comunque la stessa password/x-sync-key
// delle altre API per coerenza col resto dell'app (vedi api/events.js).
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
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo non consentito' });
    return;
  }
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    res.status(500).json({ error: 'VAPID_PUBLIC_KEY non configurata sul server' });
    return;
  }
  res.status(200).json({ publicKey });
};
