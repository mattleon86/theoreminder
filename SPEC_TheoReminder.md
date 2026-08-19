# TheoReminder — Spec di progetto (per Claude Code)

Agenda personale incarichi congregazione, utente singolo: **Matteo Piano**. Nessun login, nessun backend, budget zero.

## Decisioni già prese
- **Telefono target**: Android → PWA installabile, notifiche affidabili anche con Service Worker.
- **Hosting**: GitHub Pages (repo pubblico gratuito, es. `theoreminder`).
- **Stack**: HTML + CSS + JS vanilla, nessun framework, nessun build step. Librerie solo via CDN.
- **Persistenza**: `localStorage` (nessun database esterno).

## Librerie da CDN (cdnjs)
- **pdf.js** → estrazione testo dai PDF caricati.
- **FullCalendar** → vista calendario mensile, responsive.
- Nessuna dipendenza da installare con npm: tutto via `<script src="https://cdnjs.cloudflare.com/...">`.

## Struttura file del progetto
```
theoreminder/
├── index.html          # unica pagina, 4 tab: Dashboard / Carica PDF / Calendario / Statistiche / Impostazioni
├── style.css            # mobile-first, tema chiaro (+ toggle scuro opzionale)
├── app.js                # tutta la logica applicativa
├── manifest.json      # già pronto (vedi sotto)
├── sw.js                  # già pronto (vedi sotto)
└── icons/
    ├── icon-192.png   # icona PWA (da generare, anche un quadrato semplice va bene)
    └── icon-512.png
```

### `manifest.json` (già creato, pronto all'uso)
```json
{
  "name": "TheoReminder",
  "short_name": "TheoReminder",
  "description": "Agenda personale incarichi congregazione - Matteo Piano",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#2563eb",
  "orientation": "portrait",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

### `sw.js` (già creato, pronto all'uso)
```js
// Service Worker minimale: cache statica per uso offline + supporto notifiche.
const CACHE_NAME = 'theoreminder-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Solo file locali dell'app: le richieste ai CDN (pdf.js, FullCalendar) passano dritte alla rete.
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

// Click su una notifica: apre/porta in primo piano l'app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus();
      } else {
        self.clients.openWindow('./index.html');
      }
    })
  );
});
```

## Modello dati (localStorage)

> Aggiornato dopo i primi test reali dell'utente (19/08/2026): vedi "Decisioni prese dopo i primi test" più sotto per il perché di ogni scelta.

Chiave `tr_events` → array di oggetti:
```json
{
  "id": "uuid-generato",
  "title": "Discorso",
  "date": "2026-08-15",
  "time": "18:30",
  "description": "Note libere / dettagli incarico",
  "sourcePdf": "nome_file_originale.pdf",
  "reminder": { "type": "1day", "customDays": null },
  "reminderFired": false,
  "createdAt": "2026-08-19T10:00:00.000Z"
}
```
Valori possibili `reminder.type`: `"none" | "3days" | "1day" | "custom"` (se `custom`, `customDays` è il numero di **giorni** prima — non più minuti).

`title` è testo libero (non più un `<select>` vincolato): viene precompilato automaticamente dal parser del PDF con un suggerimento di ruolo (Lettore, Presidente, Dimostrazione, Discorso, Libro, Pulizie, Servizio di campo, o il nome della colonna/ruolo nei programmi tecnici), sempre modificabile a mano.

Chiave `tr_settings`:
```json
{
  "notificationsEnabled": false
}
```
Niente più `theme`: l'app ha solo il tema chiaro, nessuna opzione di aspetto.

## Funzionalità v1 (dettaglio)

### 1. Caricamento PDF
- `<input type="file" accept="application/pdf" multiple>` + zona di drag&drop: **più file insieme**, non uno alla volta.
- Estrazione testo con pdf.js (`getDocument` → per ogni pagina `getTextContent`), mantenendo anche le coordinate x/y grezze di ogni elemento di testo (servono per l'estrazione a colonne, vedi punto 2).
- Anteprima testo estratto (di tutti i file caricati, concatenati) in una `<textarea readonly>`.
- Risultati mostrati raggruppati per file, con intestazione `nome_file.pdf — N incarichi trovati`.

### 2. Estrazione incarichi di "Piano"
- Cerca solo il **cognome "Piano"** (maiuscolo, per non confonderlo con la comune parola italiana "piano"), non più "Matteo Piano" per intero: è l'unico cognome così nei programmi. Esclude esplicitamente le righe con "Ester" (l'unica altra persona con questo cognome nei documenti).
- **Estrazione a colonne** (per PDF come "Programma Incarichi Adunanze Pubbliche" organizzati con intestazioni di ruolo — Video, Mixer, Mic + PODIO, Microfono, Sala, Porta, Esterno — su colonne verticali): se la pagina contiene almeno 3 di queste etichette, si abbina ogni occorrenza di "Piano" alla colonna più vicina per coordinata x e alla data più vicina per coordinata y, invece di leggere riga per riga.
- **Estrazione riga per riga** (tutti gli altri PDF): per ogni riga con "Piano", si costruisce un contesto (±2 righe) usato per indovinare data e ruolo, con questa priorità decisa dall'utente dopo i test:
  1. `assistente:`/`consigliere:` sulla riga → ruolo "Dimostrazione" (scuola di ministero teocratico).
  2. `30 min` sulla riga → ruolo "Libro" (conduttore studio di libro/congregazione).
  3. Parola "Presidente"/"Lettore"/"Discorso" (anche "Discoro", refuso comune nell'estrazione) sulla riga → quel ruolo.
  4. Resto della riga dopo aver tolto "Piano"/"Matteo": se sembra un altro Nome Cognome → "Dimostrazione" (parte a due); se è una frase → "Discorso" (probabile tema di un discorso).
  5. Altrimenti "Altro".
  - Data: prima sulla riga esatta del match, poi sul contesto, poi (per "Orari Adunanze Servizio di Campo") sul giorno della settimana indicato (es. "Sabato") calcolando la prossima occorrenza da oggi, infine sull'intera pagina.
  - **Deduplica**: se lo stesso giorno il nome compare più volte e le occorrenze extra sono legate a "cantico" o "3 min", vengono scartate (fanno parte dell'incarico di Presidente già individuato quel giorno, non incarichi separati).
- Bottone "Salva nel calendario" per riga → scrive un nuovo oggetto in `tr_events`.

### 3. Calendario
- FullCalendar, vista mese di default, responsive.
- Eventi caricati da `tr_events`.
- Click su evento → popup/modal con titolo, data, ora, descrizione.

### 4. Promemoria/notifiche
- Al primo utilizzo: richiesta permesso `Notification.requestPermission()`.
- Per ogni incarico: select con `nessuno / 3 giorni prima / 1 giorno prima / personalizzato (in giorni)`.
- Motore di controllo: `setInterval` ogni 20-30s che confronta `now` con `data+ora evento - offset`; se è il momento e `reminderFired=false`, mostra la notifica (via `serviceWorkerRegistration.showNotification` se disponibile, altrimenti `new Notification()`), poi marca `reminderFired=true` e salva.
- Al riavvio/apertura app: ricalcola tutti i timer dai dati salvati (nessun timer viene perso). Promemoria "mancati" perché l'app era chiusa (ma entro 12h) vengono comunque mostrati al primo avvio successivo.
- **Limite onesto da comunicare all'utente**: le notifiche funzionano bene se il telefono/Chrome tengono l'app installata come PWA (Android). Se il browser resta chiuso per molti giorni, Android può "congelare" il service worker: al riapertura i promemoria arretrati vengono comunque recuperati, ma non è garantita puntualità assoluta al minuto se il telefono è offline o l'app non viene mai aperta.

### 5. Esportazione CSV
- Bottone "Esporta i miei incarichi" → genera file `.csv` (separatore `;`, BOM UTF-8 per Excel italiano, colonne Data/Ora/Ruolo/Descrizione/Promemoria/File PDF di origine) e lo scarica via `Blob` + link `download`.

### 6. Statistiche
- Totale incarichi salvati.
- Incarichi per mese (lista o grafico a barre semplice, anche solo con `<div>` e CSS, niente librerie extra necessarie).
- Incarichi per ruolo/tipo (conteggio da `title`).

### 7. Dashboard
- Prossimi 3-5 incarichi (ordinati per data/ora, solo futuri).
- Totale incarichi anno corrente.
- Ruolo più frequente.
- Avviso "⚠️ Incarichi nello stesso giorno" se due o più incarichi cadono sulla stessa data (stesso controllo scatta anche come toast subito dopo aver salvato un incarico che crea il conflitto).
- Nessun pulsante di azione rapida (rimossi su richiesta dell'utente).

### 8. Modifica incarichi dal calendario
- Click su un incarico → popup di modifica completo (ruolo, data, ora, note, promemoria), non solo visualizzazione.
- Trascinamento (drag & drop, o "tieni premuto" su touch) di un incarico su un'altra data → si apre lo stesso popup con la nuova data già impostata, da confermare o correggere. Se il popup si chiude senza salvare, l'incarico torna alla data originale.
- Se data/ora/promemoria cambiano, `reminderFired` si resetta (il promemoria può scattare di nuovo); se cambia solo il testo, resta invariato.

### 9. Lucchetto (password)
- Il repository GitHub è **pubblico** (necessario per GitHub Pages gratuito): questa protezione **non è vera sicurezza**, serve solo a tenere fuori i visitatori casuali. Chi legge il codice sorgente pubblico può risalire, con lavoro, alla password.
- All'apertura, se `localStorage.tr_unlocked !== 'true'`, viene mostrata una schermata a schermo intero con richiesta password (hash SHA-256 confrontato con un valore fisso in `app.js`), prima che il resto della pagina sia visibile (nessun "lampeggio" di contenuto).
- Password corretta → `tr_unlocked` salvato in `localStorage`: il dispositivo resta sbloccato finché non si cancellano i dati del sito o non si usa un browser/dispositivo diverso.
- In Impostazioni → Sicurezza: pulsante "Blocca subito l'app" per ribloccare manualmente (es. prima di prestare il telefono).

## Decisioni prese dopo i primi test (19/08/2026)
Dopo aver testato l'app con i PDF reali, l'utente ha chiesto e ottenuto queste modifiche rispetto alla v1 iniziale:
- **Niente tema scuro/opzioni di aspetto**: solo tema chiaro, nessun toggle.
- **Niente backup/ripristino JSON**: rimosso, non necessario per l'uso previsto.
- **Export CSV invece di .ics**: più comodo da aprire in Excel.
- **Caricamento multiplo di PDF**: selezione o drag&drop di più file insieme, non uno alla volta.
- **Ruolo come testo libero precompilato**, non più da scegliere da un menu: l'app scrive già il ruolo indovinato, l'utente lo corregge solo se serve.
- **Promemoria in giorni** (3gg/1gg/personalizzato in giorni), non più in ore/minuti.
- **Ricerca solo sul cognome "Piano"**, non più "Matteo Piano" per intero (più affidabile sui PDF con nome e cognome su righe separate).

## UX/UI
- Mobile-first, tema chiaro di default, toggle scuro opzionale (salvato in `tr_settings.theme`).
- Nav bar in alto con le 5 sezioni (Dashboard, Carica PDF, Calendario, Statistiche, Impostazioni/Backup).
- Card e bottoni grandi, comodi da toccare col pollice.

## Deploy su GitHub Pages (passo-passo)
1. Crea un account GitHub gratuito (se non già presente).
2. Crea un nuovo repository pubblico, es. `theoreminder`.
3. Carica tutti i file di questo progetto nella root del repo (via interfaccia web "Add file → Upload files", oppure `git push`).
4. Vai in **Settings → Pages** del repo → Source: `Deploy from a branch` → Branch: `main` / cartella `/ (root)` → Save.
5. Dopo 1-2 minuti l'app è raggiungibile su `https://<tuo-utente>.github.io/theoreminder/`.
6. Da Android, apri l'URL in Chrome → menu (⋮) → "Aggiungi a schermata Home" → l'app si installa come PWA e può inviare notifiche.

## Ordine di sviluppo consigliato (per Claude Code)
1. Scheletro `index.html` + `style.css` con le 5 sezioni e navigazione a tab, dati finti nel calendario.
2. Modulo storage (`localStorage`) + rendering Dashboard/Calendario dai dati reali.
3. Upload PDF + estrazione testo (pdf.js) + ricerca "Matteo Piano" + form di conferma/salvataggio incarico.
4. Motore promemoria (permesso notifiche, calcolo timer, ricalcolo all'avvio).
5. Export `.ics`, backup/ripristino JSON.
6. Sezione Statistiche.
7. Rifinitura UI mobile + test su Android reale.

## File PDF di esempio già forniti dall'utente (per test dell'estrazione)
- `Adunanza_pubblica_agostodicembre_2026.pdf`
- `Gruppi_di_servizio__aggiornato_05.2026.pdf`
- `Orari_Adunanze_Servizio_di_Campo_CONGREGAZIONE_Agg.0526.pdf`
- `Programma_ASC_MaggioAgosto_26.pdf`
- `Programma_Incarichi_Adunanze_Pubbliche_LugSet_2026.pdf`
- `Programma_Pulizie_MaggioAgosto_2026.pdf`
- `082026.pdf`, `092026.pdf`, `102026.pdf`

Usali per testare l'estrazione automatica "Matteo Piano" e verificare come si comporta il parsing riga-per-riga su formati diversi (tabelle, elenchi, calendari mensili).
