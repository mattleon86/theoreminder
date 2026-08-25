// Funzione serverless Vercel invocata dal Cron di Vercel (vedi vercel.json): controlla gli
// incarichi salvati e invia una notifica Web Push "vera" per quelli il cui promemoria è dovuto,
// anche se l'app non è aperta su nessun dispositivo. Questo sostituisce/affianca il motore a
// setTimeout lato client (app.js), che funziona solo con la scheda/app aperta.
//
// Approfitta anche di questa stessa esecuzione per fare, una volta al mese, un backup separato
// degli incarichi (vedi backupIfDue): il piano gratuito di Vercel permette solo 2 Cron Job per
// progetto e li usiamo già entrambi per i promemoria, quindi il backup mensile viaggia "a bordo"
// di questa funzione invece di averne una terza dedicata.
const { kv } = require('@vercel/kv');
const webpush = require('web-push');

const EVENTS_KEY = 'theoreminder:events';
const SUBS_KEY = 'theoreminder:push-subscriptions';
const BACKUP_PREFIX = 'theoreminder:events-backup:';
const BACKUP_INDEX_KEY = 'theoreminder:events-backup-index';
const KEEP_BACKUPS = 12; // ~1 anno di storico mensile
const REMINDER_DAYS = { '3days': 3, '1day': 1 };
// Il piano gratuito di Vercel esegue i Cron Job al massimo una volta al giorno per job (qui ne
// usiamo due, mattina e sera: vedi vercel.json). Finestra più larga di quella usata dal motore
// lato client (12h) per non perdere un promemoria tra un'esecuzione e l'altra.
const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req) {
  // Quando la variabile d'ambiente CRON_SECRET è impostata su Vercel, le chiamate generate dal
  // Cron di Vercel includono automaticamente questo header: così solo Vercel (o chi conosce il
  // segreto) può invocare l'invio dei promemoria.
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return req.headers['authorization'] === `Bearer ${expected}`;
}

function getReminderOffsetMs(reminder) {
  if (!reminder || reminder.type === 'none') return null;
  const days = reminder.type === 'custom' ? (reminder.customDays || 0) : REMINDER_DAYS[reminder.type];
  if (!days) return null;
  return days * 24 * 60 * 60 * 1000;
}

function formatDateIt(dateStr, time) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}${time ? ' alle ' + time : ''}`;
}

// Salva uno snapshot degli incarichi una volta al mese (idempotente: se rieseguito più volte lo
// stesso giorno sovrascrive semplicemente lo snapshot del mese corrente) e tiene solo gli ultimi
// KEEP_BACKUPS mesi. Serve come rete di sicurezza se theoreminder:events si rompe o si svuota per
// errore: consultabile/recuperabile da api/list-backups.js.
async function backupIfDue(events) {
  const now = new Date();
  if (now.getUTCDate() !== 1) return; // solo il primo giorno del mese (UTC)

  const label = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  await kv.set(`${BACKUP_PREFIX}${label}`, { savedAt: now.toISOString(), events });

  const index = (await kv.get(BACKUP_INDEX_KEY)) || [];
  if (!index.includes(label)) index.push(label);
  index.sort();
  while (index.length > KEEP_BACKUPS) {
    const oldest = index.shift();
    await kv.del(`${BACKUP_PREFIX}${oldest}`);
  }
  await kv.set(BACKUP_INDEX_KEY, index);
}

module.exports = async function handler(req, res) {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'Non autorizzato' });
    return;
  }

  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) {
    res.status(500).json({ error: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY non configurate sul server' });
    return;
  }
  webpush.setVapidDetails('mailto:matteoester.piano@gmail.com', vapidPublic, vapidPrivate);

  const events = (await kv.get(EVENTS_KEY)) || [];
  await backupIfDue(events);

  let subs = (await kv.get(SUBS_KEY)) || [];
  if (subs.length === 0) {
    res.status(200).json({ ok: true, sent: 0, note: 'Nessun dispositivo sottoscritto' });
    return;
  }

  const now = Date.now();
  const due = events.filter((evt) => {
    if (evt.reminderFired) return false;
    const offset = getReminderOffsetMs(evt.reminder);
    if (offset === null) return false;
    const eventTime = new Date(evt.date + 'T' + (evt.time || '00:00')).getTime();
    const fireTime = eventTime - offset;
    return now >= fireTime && now - fireTime < MISSED_WINDOW_MS;
  });

  if (due.length === 0) {
    res.status(200).json({ ok: true, sent: 0 });
    return;
  }

  const deadEndpoints = new Set();
  for (const evt of due) {
    const payload = JSON.stringify({
      title: 'Promemoria incarico',
      body: `${evt.title} — ${formatDateIt(evt.date, evt.time)}`
    });
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        // 404/410 = sottoscrizione scaduta o revocata dal browser: la ripuliamo sotto.
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          deadEndpoints.add(sub.endpoint);
        }
      }
    }));
    evt.reminderFired = true;
  }

  if (deadEndpoints.size > 0) {
    subs = subs.filter((s) => !deadEndpoints.has(s.endpoint));
    await kv.set(SUBS_KEY, subs);
  }

  await kv.set(EVENTS_KEY, events);
  res.status(200).json({ ok: true, sent: due.length });
};
