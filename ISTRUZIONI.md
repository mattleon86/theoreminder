# ISTRUZIONI — TheoReminder

Istruzioni operative per chi modifica questo progetto (umano o AI). Aggiornare questo file a ogni modifica non triviali, **prima** del commit.

## 1. Cos'è
Agenda personale degli incarichi di congregazione (PWA, un solo utente). Nessun build step: HTML + CSS + JS vanilla, librerie da CDN.

## 2. File principali
| File | Contiene |
|---|---|
| `index.html` | unica pagina: sezioni Dashboard, Carica PDF, Calendario, Statistiche, Impostazioni, schermata di blocco, modale incarico, lightbox |
| `app.js` | tutta la logica client, in un IIFE: lucchetto, impronta, sync, parser PDF, calendario, promemoria, CSV, statistiche |
| `style.css` | design system "agenda editoriale", tema chiaro, mobile-first (nav in basso) / desktop (nav laterale) |
| `sw.js` | Service Worker: cache `theoreminder-v5` **rete-prima** (l'app si aggiorna da sola; la cache serve solo offline) + gestione notifiche push |
| `manifest.json`, `icons/` | PWA installabile |
| `api/*.js` | funzioni serverless Vercel (KV, push, cron, backup) |
| `vercel.json` | cron mattina/sera (UTC) |
| `THEOREMINDER-COMPLETO.md` (fuori repo) | documento di progetto completo |

## 3. Dati (localStorage, chiavi)
- `tr_events` → array di incarichi (`id`, `title`, `date`, `time`, `description`, `sourcePdf`, `reminder`, `reminderFired`, `reminderFiredAt`, `updatedAt`, `createdAt`).
- `tr_settings` → `{ notificationsEnabled }`.
- `tr_deleted` → tombstone `{ id: ISO }` delle eliminazioni (per la sync).
- `tr_webauthn_credential_id`, `tr_webauthn_password` → solo se l'utente attiva l'impronta su quel dispositivo.

**Regola assoluta:** nessuna modifica allo SW o ai nomi di queste chiavi deve far perdere dati all'utente finale. Le versioni vecchie dei dati devono restare leggibili.

## 4. Sincronizzazione (Vercel KV)
- Endpoint `GET/PUT /api/events` (payload `{ events, deleted }`), autenticazione header **`X-Sync-Key`** = password dell'app, confrontata con env `SYNC_SECRET` (solo su Vercel).
- Ogni operazione è **pull → merge → eventuale push**, messa in coda seriale da `enqueueSync` (mai in parallelo): una risposta vecchia del server non può sovrascrivere una modifica locale. Anche il salvataggio locale (`Storage.saveEvents`) fa `enqueueSync(syncOnce)`, non un PUT diretto.
- Il merge è **per evento**: vince l'evento con `updatedAt` più recente (ogni `addEvent`/`updateEvent` lo aggiorna). Le eliminazioni viaggiano come tombstone in `tr_deleted` (`{ id: ISO }`, TTL 60 giorni) e vincono solo se più recenti dell'`updatedAt` dell'evento. "Cancella tutti i dati" crea un tombstone per ogni evento, così si cancella anche sugli altri dispositivi.
- I confronti di stato (`sameEventList`/`sameDeletedMap`) sono **indipendenti dall'ordine**: senza, due dispositivi si rispedirebbero i dati a ogni polling.

## 5. Promemoria (due motori, uno solo deve inviare)
1. **Client** (`app.js`, polling 25 s + `setTimeout`): notifica se l'app è aperta, finestra "mancati" 12 h.
2. **Server** (`api/send-reminders.js`, cron 06:00 e 18:00 UTC): Web Push, finestra 24 h, funziona anche ad app chiusa.
Dopo l'invio entrambi scrivono `reminderFired=true` + `reminderFiredAt` e lo sincronizzano: l'altro motore, vedendo il flag (o un `reminderFiredAt` entro 24 h), **non reinvia**. Il client marca **prima** di mostrare la notifica, così il cron imminente vede già il flag. Non introdurre percorsi di invio che non passino da questi controlli. Se cambiano data/ora/promemoria, `reminderFired`/`reminderFiredAt` vengono azzerati (il promemoria riparte da capo).

## 6. Sicurezza
Password confrontata con hash SHA-256 fisso in `app.js` (`LOCK_PASSWORD_HASH`): il repo è pubblico, NON è vera sicurezza. L'impronta (WebAuthn) rilascia la password salvata localmente solo dopo il riconoscimento biometrico.

## 7. Regole di lavoro
- Lingua dei commenti e della UI: **italiano**.
- Solo librerie/servizi gratuiti; nessun pagamento, nessuna carta.
- Dopo ogni modifica non triviali: aggiorna **questo file** e `THEOREMINDER-COMPLETO.md`.
- **Deploy: chiedere SEMPRE conferma esplicita all'utente prima di commit/push/Vercel.**
- Il Service Worker deve aggiornarsi da solo (nessun ricaricamento manuale da parte dell'utente finale) senza cancellare i dati.

## 8. Deploy
`git push` su `main` → Vercel pubblica automaticamente (nessuna build lato frontend). Env da tenere su Vercel: `SYNC_SECRET`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.

## 9. Interfaccia (design system)
Direzione: **agenda editoriale** — carta fredda, inchiostro verde, filetti sottili, un solo elemento protagonista per schermata. Solo tema chiaro (scelta dell'utente: **niente tema scuro**).

- Token in `:root` di `style.css`: `--paper #f5f6f2`, `--ink #16231f`, `--surface #fff`, `--accent #116b58`, `--muted #69766f`, `--line #dbe2dd`, `--amber #a86b18` (solo avvisi), `--danger #a8362b`.
- Tipi: **Newsreader** (serif) per titoli, numeri e wordmark; **Manrope** (sans) per UI. Vengono da Google Fonts (gratuiti) con fallback di sistema, quindi l'app resta leggibile anche offline.
- Icone: **SVG inline** con `stroke="currentColor"` in `index.html` (niente emoji nei controlli; le emoji residue generate da `app.js` sono state tolte). Per un'icona nuova, copia lo stile delle altre.
- Struttura: `.bottom-nav` è barra fissa in basso su mobile e **colonna laterale** da 960 px in su. `main` ha `margin-left: 240px` su desktop. La Dashboard usa `.dashboard-grid` (2 colonne su desktop).
- Regole: tocco minimo 44 px, focus visibile, `prefers-reduced-motion` rispettato, testi in italiano. Non aggiungere gradienti/ombre multiple o temi scuri: il carattere viene dalla tipografia e dai filetti, non dalla decorazione.
- Il primo `#upcoming-list .card` è il "prossimo incarico" in evidenza: se cambi la struttura di `renderDashboard()` in `app.js`, aggiorna anche i selettori `:first-child` in `style.css`.
