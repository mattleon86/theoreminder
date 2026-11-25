'use strict';

const { requireSyncKey } = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (!requireSyncKey(req, res)) return;
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
