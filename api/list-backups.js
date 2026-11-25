'use strict';

const { requireSyncKey } = require('../lib/auth');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (!requireSyncKey(req, res)) return;

  try {
    if (req.method === 'GET') {
      const label = req.query && req.query.label;
      if (label !== undefined && label !== '' && !store.isValidBackupLabel(label)) {
        res.status(400).json({ error: 'Etichetta backup non valida' });
        return;
      }
      if (label) {
        const backup = await store.getBackup(label);
        if (!backup) {
          res.status(404).json({ error: 'Backup non trovato' });
          return;
        }
        res.status(200).json(backup);
        return;
      }

      const labels = await store.backupLabels();
      res.status(200).json({ backups: labels, lastBackup: await store.getLastBackupInfo(undefined, labels) });
      return;
    }

    if (req.method === 'POST') {
      const state = await store.getState();
      const created = await store.createBackup(state, store.manualBackupLabel(), 'manual');
      const lastBackup = await store.getLastBackupInfo();
      res.status(200).json({ ok: true, label: created.label, created: created.created, lastBackup });
      return;
    }

    res.status(405).json({ error: 'Metodo non consentito' });
  } catch (_) {
    res.status(500).json({ error: 'Errore interno dei backup' });
  }
};
