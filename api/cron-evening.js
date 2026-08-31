// Wrapper sottile per il Cron delle 18:00 UTC: stessa logica di api/send-reminders.js.
// Esiste come file/percorso separato da api/cron-morning.js perché il Cron di Vercel sembra
// non gestire bene due schedulazioni diverse sullo stesso percorso (i job non partivano più da
// soli, pur risultando "registrati" — vedi commit che ha introdotto questo file per i dettagli).
module.exports = require('./send-reminders');
