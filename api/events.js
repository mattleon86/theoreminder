'use strict';

const { requireSyncKey } = require('../lib/auth');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (!requireSyncKey(req, res)) return;

  try {
    if (req.method === 'GET') {
      res.status(200).json(await store.getState());
      return;
    }

    if (req.method === 'PUT') {
      let body = req.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch (_) {
          res.status(400).json({ error: 'JSON non valido' });
          return;
        }
      }

      let incoming;
      try {
        incoming = store.normalizeIncomingState(body);
      } catch (_) {
        res.status(400).json({ error: 'Corpo della richiesta non valido' });
        return;
      }
      const state = await store.mergeState(incoming);
      res.status(200).json(Object.assign({ ok: true }, state));
      return;
    }

    res.status(405).json({ error: 'Metodo non consentito' });
  } catch (_) {
    res.status(500).json({ error: 'Errore interno di sincronizzazione' });
  }
};
