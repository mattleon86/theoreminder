// Funzione serverless Vercel: consente di consultare/recuperare gli snapshot mensili creati da
// api/backup-events.js, in caso di emergenza (dati principali persi o corrotti).
// - GET senza parametri  → elenco delle etichette dei backup disponibili (es. "2026-08")
// - GET ?label=2026-08   → contenuto di quel backup ({ savedAt, events })
// Stessa autenticazione delle altre API (password del lucchetto == X-Sync-Key == SYNC_SECRET).
const { kv } = require('@vercel/kv');

const BACKUP_PREFIX = 'theoreminder:events-backup:';
const BACKUP_INDEX_KEY = 'theoreminder:events-backup-index';

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

  const label = req.query && req.query.label;
  if (label) {
    const backup = await kv.get(`${BACKUP_PREFIX}${label}`);
    if (!backup) {
      res.status(404).json({ error: 'Backup non trovato per questo mese' });
      return;
    }
    res.status(200).json(backup);
    return;
  }

  const index = (await kv.get(BACKUP_INDEX_KEY)) || [];
  res.status(200).json({ backups: index.slice().sort().reverse() });
};
