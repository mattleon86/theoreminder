'use strict';

const webpush = require('web-push');
const core = require('../shared/core');
const { requireCronSecret } = require('../lib/auth');
const store = require('../lib/store');

const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;

function formatDateIt(dateStr, time) {
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}${time ? ' alle ' + time : ''}`;
}

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (_) {
    return '';
  }
}

module.exports = async function handler(req, res) {
  if (!requireCronSecret(req, res)) return;

  let events = 0;
  let deliveries = 0;
  let backupInfo = null;
  try {
    const state = await store.getState();
    try {
      const backup = await store.createBackup(state, store.monthlyBackupLabel(), 'cron');
      backupInfo = { label: backup.label, created: backup.created };
    } catch (_) {
      console.error('Backup automatico non riuscito');
    }

    const now = Date.now();
    const due = state.events.filter((evt) => core.isReminderDue(evt, now, MISSED_WINDOW_MS, core.DEFAULT_TIME_ZONE));
    events = due.length;

    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublic || !vapidPrivate) {
      res.status(500).json({
        error: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY non configurate sul server',
        events, deliveries, backup: backupInfo
      });
      return;
    }
    if (due.length === 0) {
      res.status(200).json({ ok: true, events, deliveries, marked: 0, failures: 0, removedSubscriptions: 0, backup: backupInfo });
      return;
    }

    webpush.setVapidDetails('mailto:matteoester.piano@gmail.com', vapidPublic, vapidPrivate);
    const subscriptions = await store.listSubscriptions();
    const deadEndpoints = new Set();
    const successful = [];
    let failures = 0;
    const firedAt = new Date(now).toISOString();

    for (const evt of due) {
      const payload = JSON.stringify({
        title: 'Promemoria incarico',
        body: `${evt.title} — ${formatDateIt(evt.date, evt.time)}`,
        eventId: evt.id,
        date: evt.date,
        actions: [{ action: 'open', title: 'Apri incarico' }]
      });
      let delivered = false;
      await Promise.all(subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, payload);
          deliveries += 1;
          delivered = true;
        } catch (err) {
          failures += 1;
          const statusCode = Number(err && err.statusCode) || 0;
          if (statusCode === 404 || statusCode === 410) deadEndpoints.add(subscription.endpoint);
          console.warn('Push non consegnato', { statusCode, host: endpointHost(subscription.endpoint) });
        }
      }));
      if (delivered) successful.push({ id: evt.id, date: evt.date, time: evt.time || '', reminder: evt.reminder });
    }

    let removedSubscriptions = 0;
    if (deadEndpoints.size > 0) {
      try {
        removedSubscriptions = await store.removeSubscriptions([...deadEndpoints]);
      } catch (_) {
        console.error('Pulizia sottoscrizioni non riuscita');
      }
    }
    const marked = await store.markRemindersFired(successful, firedAt);
    res.status(200).json({ ok: true, events, deliveries, marked, failures, removedSubscriptions, backup: backupInfo });
  } catch (_) {
    console.error('Invio promemorie non riuscito');
    res.status(500).json({ error: "Errore interno durante l'invio dei promemoria", events, deliveries, backup: backupInfo });
  }
};
