# ISTRUZIONI — TheoReminder

Istruzioni operative per chi modifica questo progetto (umano o AI). Aggiornare questo file a ogni modifica non triviale, **prima** del commit.

## 1. Cos'è
Agenda personale degli incarichi di congregazione (PWA, un solo utente). Nessun build step: HTML + CSS + JS vanilla, librerie ospitate nel progetto.

## 2. File principali
| File | Contiene |
|---|---|
| `index.html` | unica pagina: Dashboard, Carica PDF, Calendario, Statistiche, Impostazioni, blocco, modale e lightbox |
| `app.js` | logica client: lucchetto, impronta, sync, parser PDF, calendario, promemoria, CSV, backup |
| `shared/core.js` | funzioni pure condivise: validazione, merge, fuso orario, promemoria, CSV |
| `style.css` | design system "agenda editoriale", mobile-first / desktop |
| `sw.js` | cache `theoreminder-v6`, allowlist statica, rete-prima, fallback offline e push |
| `boot.js` | aggiunge subito la classe `locked` prima del disegno della pagina |
| `vendor/` | FullCalendar 6.1.11 e pdf.js 3.11.174 ospitati localmente |
| `manifest.json`, `icons/` | PWA installabile, icone normali/maskable/Apple |
| `api/*.js` | funzioni serverless Vercel (KV, push, cron, backup) |
| `lib/*.js` | auth API e store KV atomico condiviso |
| `test/*.test.js` | test Node per merge, API, cron, backup e parser |
| `vercel.json` | cron, CSP e header di sicurezza |

## 3. Dati locali
- `tr_events` → array di incarichi validi (`id`, `title`, `date`, `time`, `description`, `sourcePdf`, `reminder`, `reminderFired`, `reminderFiredAt`, `updatedAt`, `createdAt`).
- `tr_settings` → `{ notificationsEnabled, timeZone: "Europe/Rome" }`.
- `tr_deleted` → tombstone `{ id: ISO }`. Non scadono: evita che eventi offline molto vecchi risorgano.
- `tr_cleared_at` → timestamp della cancellazione globale.
- `tr_sync_status` → ultima sync, errore e modifiche pendenti.
- `tr_last_local_backup`, `tr_events_corrupt` → backup pre-cancellazione e copia di dati non validi.

**Regola assoluta:** non rinominare queste chiavi né eliminare dati vecchi senza migrazione. I dati non validi vengono conservati in `tr_events_corrupt`, non sovrascritti silenziosamente.

## 4. Sincronizzazione
- Endpoint `GET/PUT /api/events`, auth `X-Sync-Key` = `SYNC_SECRET`.
- Stato server in `theoreminder:state`: `{ events: {id: evento}, deleted, clearedAt }`.
- Il merge avviene **dentro Lua atomico** nel server: due PUT concorrenti non si perdono eventi distinti.
- Migrazione automatica dalle vecchie chiavi `theoreminder:events` e `theoreminder:deleted`.
- Il client fa pull → merge → push in coda seriale, con timeout 12 s e `cache: no-store`.
- `clearedAt` elimina anche eventi che il dispositivo che cancella non aveva ancora visto.
- Errori HTTP/timeout sono visibili nel banner e in Impostazioni → Stato e backup.

## 5. Promemoria
1. Client: polling 25 s + timer, finestra mancati 12 h.
2. Server: cron 06:00/18:00 UTC, Web Push, finestra 24 h.

- Calcolo data/ora in **Europe/Rome**, corretto anche per cambio ora legale.
- Il server marca `reminderFired` soltanto dopo almeno una consegna riuscita e solo se data/ora/promemoria non sono cambiati durante l'invio.
- Il client controlla il permesso prima di consumare il promemoria; se la notifica fallisce, annulla il flag.
- Il payload push include `eventId`: il click apre l'incarico con `#event=<id>`.

## 6. Backup
- Backup mensile creato una sola volta per mese, anche senza VAPID; ultimi 12 mesi.
- Backup manuale da Impostazioni → Stato e backup e prima di "Cancella tutti".
- Esportazione/importazione JSON validata; l'importazione fa merge, non sovrascrive alla cieca.
- Il backup mensile non viene sovrascritto la stessa sera.

## 7. Sicurezza
- Password confrontata con hash SHA-256 fisso: protezione "soft", non vera autenticazione.
- Impronta WebAuthn opzionale per dispositivo; la password salvata in base64 è una scorciatoia tecnica, non protezione crittografica.
- API: confronto constant-time, rate limit best-effort per IP, `Cache-Control: private, no-store`.
- CSP in `vercel.json`: solo script locali, stili Google Fonts, worker locali/blob, niente inline script.
- Service Worker: esclude `/api/` e cache solo asset statici.

## 8. Regole di lavoro
- Italiano per UI e commenti; solo servizi/librerie gratuiti.
- Dopo modifiche non triviali aggiornare questo file e `THEOREMINDER-COMPLETO.md`.
- **Deploy: chiedere SEMPRE conferma esplicita prima di commit/push/Vercel.**
- Il Service Worker si aggiorna senza cancellare i dati.
- Test: `npm test`; sintassi: `npm run check`.

## 9. Interfaccia
- Tema chiaro "agenda editoriale": `--paper #f5f6f2`, `--ink #16231f`, `--accent #116b58`.
- Newsreader per titoli, Manrope per UI, fallback di sistema.
- Nav in basso su mobile, laterale da 960 px.
- Calendario: vista **Agenda** predefinita sotto 600 px; ricerca per titolo/note.
- Dashboard: i prossimi incarichi sono cliccabili/apribili da tastiera.
- Accessibilità: modale `role="dialog"`, focus bloccato/ripristinato, Esc, label, `aria-live`, focus visibile.
- Tocchi minimi 44 px, `prefers-reduced-motion` rispettato.
- FullCalendar inietta CSS a runtime: le regole evento in `style.css` usano `#calendar ...` e `--fc-event-text-color`.

## 10. Deploy
`git push` su `main` → Vercel pubblica automaticamente. Env: `SYNC_SECRET`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`. Nessuna nuova variabile obbligatoria.
