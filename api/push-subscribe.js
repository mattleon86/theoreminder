'use strict';

const { requireSyncKey } = require('../lib/auth');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (!requireSyncKey(req, res)) return;

  try {
    if (req.method === 'POST') {
      const subscription = store.normalizeSubscription(req.body && req.body.subscription);
      if (!subscription) {
        res.status(400).json({ error: 'Sottoscrizione non valida' });
        return;
      }
      await store.addSubscription(subscription);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const endpoint = store.normalizeEndpoint(req.body && req.body.endpoint);
      if (!endpoint) {
        res.status(400).json({ error: 'Endpoint non valido' });
        return;
      }
      await store.removeSubscriptions([endpoint]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Metodo non consentito' });
  } catch (_) {
    res.status(500).json({ error: 'Errore interno delle sottoscrizioni' });
  }
};
