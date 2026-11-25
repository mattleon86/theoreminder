/* ==========================================================================
   TheoReminder — app.js
   Agenda personale incarichi congregazione — Matteo Piano
   Vanilla JS, nessun framework, nessun build step.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     LUCCHETTO INIZIALE (password)
     Protezione semplice: il repository è pubblico, quindi questa NON è vera sicurezza — chi legge
     il codice sorgente può trovare l'hash e, con lavoro, risalire alla password. Serve a tenere
     fuori i visitatori casuali.
     Su richiesta esplicita dell'utente, la password viene chiesta a OGNI apertura dell'app (nessun
     "ricordami"): non la salviamo più in localStorage, resta solo in memoria per la sessione
     corrente (serve anche come chiave per autenticare la sincronizzazione col server).
     --------------------------------------------------------------------- */
  const LOCK_PASSWORD_HASH = '1b398435e9926210065809fa1ff91a10bd4bffc4f71a13497ea7a88d136f2a61';
  let syncKeyInMemory = ''; // la password inserita in questa sessione, tenuta solo in memoria

  // Ripulisce eventuali chiavi lasciate da versioni precedenti dell'app (che ricordavano lo
  // sblocco tra una sessione e l'altra): non tocca in alcun modo tr_events/tr_settings.
  function purgeLegacyUnlockStorage() {
    localStorage.removeItem('tr_unlocked');
    localStorage.removeItem('tr_sync_key');
  }

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function initLockScreen() {
    purgeLegacyUnlockStorage();

    const input = document.getElementById('lock-password-input');
    const btn = document.getElementById('lock-submit-btn');
    const errorEl = document.getElementById('lock-error');
    const fingerprintBtn = document.getElementById('lock-fingerprint-btn');
    if (!input || !btn) return;

    // Sblocco riuscito (via password o via impronta): entra nell'app e avvia le chiamate che
    // hanno bisogno della password come chiave di autenticazione (sync ed eventuale push).
    function completeUnlock(password) {
      syncKeyInMemory = password; // solo in memoria: richiesta di nuovo al prossimo avvio dell'app
      document.documentElement.classList.remove('locked');
      errorEl.classList.add('hidden');
      input.value = '';
      syncFromServerOnStartup();
      ensurePushSubscription();
      refreshBackupStatus();
      openPendingEvent();
    }

    async function tryUnlock() {
      const value = input.value;
      if (!value) return;
      const hash = await sha256Hex(value);
      if (hash === LOCK_PASSWORD_HASH) {
        completeUnlock(value);
      } else {
        errorEl.classList.remove('hidden');
        input.value = '';
        input.focus();
      }
    }

    async function tryFingerprintUnlock() {
      const password = await unlockWithFingerprint();
      if (password) {
        completeUnlock(password);
      } else {
        showToast('Sblocco con impronta non riuscito, usa la password');
      }
    }

    btn.addEventListener('click', tryUnlock);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryUnlock();
    });

    if (fingerprintBtn) {
      fingerprintBtn.addEventListener('click', tryFingerprintUnlock);
      // Il bottone appare solo se l'impronta è stata attivata su questo dispositivo (vedi
      // Impostazioni → Sicurezza) e il telefono ha davvero un sensore biometrico disponibile.
      (async () => {
        if (hasFingerprintUnlockSetup() && (await platformAuthenticatorAvailable())) {
          fingerprintBtn.classList.remove('hidden');
        }
      })();
    }
  }

  /* ---------------------------------------------------------------------
     SBLOCCO CON IMPRONTA DIGITALE (WebAuthn, opzionale, per dispositivo)
     Usa il sensore biometrico del telefono (o l'equivalente del computer) tramite l'API
     WebAuthn del browser. Per funzionare come vera scorciatoia — sia per entrare nell'app sia
     per autenticare la sincronizzazione col server, che usa la password stessa come chiave —
     la password reale deve poter essere recuperata dopo la verifica biometrica: viene quindi
     salvata su QUESTO dispositivo (non sul server), leggibile solo dopo che il sensore ha
     riconosciuto l'impronta registrata. È una scelta esplicita dell'utente, attivabile e
     disattivabile in Impostazioni → Sicurezza, dispositivo per dispositivo: prima di attivarla
     l'app non salva la password da nessuna parte (vedi sopra).
     --------------------------------------------------------------------- */
  const WEBAUTHN_CRED_ID_KEY = 'tr_webauthn_credential_id';
  const WEBAUTHN_PASSWORD_KEY = 'tr_webauthn_password';

  function webAuthnAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials);
  }

  async function platformAuthenticatorAvailable() {
    if (!webAuthnAvailable() || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch (e) {
      return false;
    }
  }

  function hasFingerprintUnlockSetup() {
    return !!(localStorage.getItem(WEBAUTHN_CRED_ID_KEY) && localStorage.getItem(WEBAUTHN_PASSWORD_KEY));
  }

  function bufferToBase64url(buf) {
    const bytes = new Uint8Array(buf);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64urlToBuffer(b64url) {
    const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const str = atob(padded);
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes.buffer;
  }

  // Registra una nuova credenziale biometrica su questo dispositivo e ci lega la password
  // corrente (quella con cui l'utente ha appena sbloccato l'app in questa sessione).
  async function setupFingerprintUnlock() {
    if (!syncKeyInMemory) {
      showToast('Sblocca prima con la password per attivare l\'impronta');
      return false;
    }
    try {
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: 'TheoReminder' },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: 'matteo.piano',
            displayName: 'Matteo Piano'
          },
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
          timeout: 60000,
          attestation: 'none'
        }
      });
      if (!credential) throw new Error('Nessuna credenziale creata');
      localStorage.setItem(WEBAUTHN_CRED_ID_KEY, bufferToBase64url(credential.rawId));
      // btoa non è crittografia: serve solo a non lasciare la password leggibile a colpo
      // d'occhio in chiaro tra le chiavi di localStorage. Il vero gate è la verifica biometrica.
      localStorage.setItem(WEBAUTHN_PASSWORD_KEY, btoa(syncKeyInMemory));
      return true;
    } catch (e) {
      return false; // utente ha annullato, o il dispositivo non supporta/ha rifiutato
    }
  }

  function disableFingerprintUnlock() {
    localStorage.removeItem(WEBAUTHN_CRED_ID_KEY);
    localStorage.removeItem(WEBAUTHN_PASSWORD_KEY);
  }

  // Chiede la verifica biometrica e, se riuscita, restituisce la password salvata su questo
  // dispositivo (altrimenti null). Non fa nessuna verifica crittografica della firma: si fida
  // del fatto che il browser abbia già richiesto la verifica dell'utente (userVerification:
  // 'required') prima di far risolvere la Promise — coerente con il livello di sicurezza
  // "casuale" dichiarato per l'intera app (vedi commento sul lucchetto, sopra).
  async function unlockWithFingerprint() {
    const credIdB64 = localStorage.getItem(WEBAUTHN_CRED_ID_KEY);
    const storedPw = localStorage.getItem(WEBAUTHN_PASSWORD_KEY);
    if (!credIdB64 || !storedPw) return null;
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: base64urlToBuffer(credIdB64), type: 'public-key' }],
          userVerification: 'required',
          timeout: 60000
        }
      });
      if (!assertion) return null;
      return atob(storedPw);
    } catch (e) {
      return null; // impronta non riconosciuta, annullato, o credenziale non più valida
    }
  }

  function initSecuritySettings() {
    const btn = document.getElementById('fingerprint-toggle-btn');
    const statusEl = document.getElementById('fingerprint-status');
    if (!btn || !statusEl) return;

    async function updateStatus() {
      if (!webAuthnAvailable()) {
        statusEl.textContent = 'Non supportata su questo browser.';
        btn.disabled = true;
        return;
      }
      if (!(await platformAuthenticatorAvailable())) {
        statusEl.textContent = 'Nessun sensore di impronte/biometria rilevato su questo dispositivo.';
        btn.disabled = true;
        return;
      }
      btn.disabled = false;
      if (hasFingerprintUnlockSetup()) {
        statusEl.textContent = 'Attiva su questo dispositivo.';
        btn.textContent = 'Disattiva impronta digitale';
      } else {
        statusEl.textContent = 'Non attiva su questo dispositivo.';
        btn.textContent = 'Attiva impronta digitale';
      }
    }

    btn.addEventListener('click', async () => {
      if (hasFingerprintUnlockSetup()) {
        disableFingerprintUnlock();
        showToast('Impronta digitale disattivata su questo dispositivo');
      } else {
        const ok = await setupFingerprintUnlock();
        showToast(ok ? 'Impronta digitale attivata su questo dispositivo' : 'Impronta non attivata');
      }
      updateStatus();
    });

    updateStatus();
  }

  /* ---------------------------------------------------------------------
     SINCRONIZZAZIONE (funzione serverless Vercel + Vercel KV)
     L'app funziona comunque offline con localStorage come copia locale; quando c'è connessione
     e la chiave di sync è disponibile (dopo aver sbloccato l'app), si sincronizza col server:
     - all'avvio: se il server ha dati, li adotta; se il server è vuoto ma il dispositivo ha già
       dati locali (primo avvio dopo aver attivato la sync), li carica lui sul server;
     - a ogni salvataggio locale, invia la lista aggiornata al server;
     - ogni 30s (se la scheda è visibile), ricontrolla se sono arrivati dati da un altro dispositivo.
     Conflitti: merge PER EVENTO, vince chi ha `updatedAt` più recente (niente sovrascritture alla
     cieca: due dispositivi che modificano vicino non si cancellano a vicenda) e le eliminazioni
     viaggiano come tombstone (`tr_deleted`), quindi non "risorgono".
     Pull e push vanno in coda uno dopo l'altro (syncChain): una risposta "vecchia" del server
     non può eseguirsi dopo una modifica locale appena fatta.
     --------------------------------------------------------------------- */
  const SYNC_ENDPOINT = '/api/events';
  const BACKUPS_ENDPOINT = '/api/list-backups';
  const SYNC_TIMEOUT_MS = 12000;
  const Core = window.TheoCore;

  let syncChain = Promise.resolve(); // coda seriale delle operazioni di sync
  let lastSyncAt = '';
  let lastSyncError = '';
  let pendingSync = false;

  function getSyncKey() {
    return syncKeyInMemory;
  }

  function enqueueSync(task) {
    syncChain = syncChain.then(task, task);
    return syncChain;
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal, cache: 'no-store' }));
    } finally {
      clearTimeout(timer);
    }
  }

  function setSyncStatus(state, message) {
    lastSyncError = state === 'error' ? (message || 'Errore di sincronizzazione') : '';
    if (state === 'ok') {
      lastSyncAt = new Date().toISOString();
      pendingSync = false;
    } else if (state === 'pending') {
      pendingSync = true;
    }
    try {
      localStorage.setItem('tr_sync_status', JSON.stringify({ lastSyncAt, lastSyncError, pendingSync }));
    } catch (e) { /* stato visivo opzionale */ }
    updateSyncStatusUi();
  }

  function updateSyncStatusUi() {
    const el = document.getElementById('sync-status');
    if (el) {
      if (!getSyncKey()) el.textContent = 'Inserisci la password per sincronizzare.';
      else if (lastSyncError) el.textContent = lastSyncError;
      else if (lastSyncAt) el.textContent = 'Ultima sincronizzazione: ' + new Date(lastSyncAt).toLocaleString('it-IT');
      else el.textContent = pendingSync ? 'Modifiche locali in attesa di sincronizzazione.' : 'Sincronizzazione non ancora verificata.';
    }
    const banner = document.getElementById('connection-banner');
    if (!banner) return;
    const offline = navigator.onLine === false;
    const show = !!getSyncKey() && (offline || !!lastSyncError || pendingSync);
    banner.classList.toggle('hidden', !show);
    banner.textContent = offline ? 'Offline — le modifiche restano su questo dispositivo.' :
      (lastSyncError || 'Modifiche locali in attesa di sincronizzazione.');
  }

  async function syncPull() {
    const key = getSyncKey();
    if (!key) return null;
    const res = await fetchWithTimeout(SYNC_ENDPOINT, { headers: { 'X-Sync-Key': key } });
    if (res.status === 401) throw new Error('Password di sincronizzazione non valida.');
    if (!res.ok) throw new Error('Sincronizzazione non riuscita (' + res.status + ').');
    const data = await res.json();
    return Core.normalizeState(data);
  }

  async function syncPush(state) {
    const key = getSyncKey();
    if (!key) return null;
    const res = await fetchWithTimeout(SYNC_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Key': key },
      body: JSON.stringify(Core.normalizeState(state))
    });
    if (!res.ok) throw new Error('Invio delle modifiche non riuscito (' + res.status + ').');
    return Core.mergeStates({}, await res.json());
  }

  function mergeSyncState(local, server) {
    return Core.mergeStates(local, server);
  }

  function sameEventList(a, b) { return Core.sameEventList(a, b); }
  function sameDeletedMap(a, b) { return Core.sameDeletedMap(a, b); }

  function refreshAllViewsAfterSync() {
    recalcAllReminders();
    renderDashboard();
    renderStats();
    if (document.getElementById('view-calendar').classList.contains('active')) renderCalendar();
  }

  function applyMergedState(merged, previous) {
    const eventsChanged = !sameEventList(merged.events, previous.events);
    const deletedChanged = !sameDeletedMap(merged.deleted, previous.deleted);
    const clearedChanged = (merged.clearedAt || '') !== (previous.clearedAt || '');
    if (!eventsChanged && !deletedChanged && !clearedChanged) return false;
    try {
      localStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(merged.events));
      localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(merged.deleted));
      localStorage.setItem(STORAGE_CLEARED_KEY, merged.clearedAt || '');
    } catch (e) {
      setSyncStatus('error', 'Impossibile salvare i dati sul dispositivo.');
      return false;
    }
    if (eventsChanged || clearedChanged) refreshAllViewsAfterSync();
    return true;
  }

  async function syncOnce() {
    if (!getSyncKey()) return false;
    setSyncStatus('pending');
    try {
      const server = await syncPull();
      const local = { events: Storage.getEvents(), deleted: Storage.getDeleted(), clearedAt: Storage.getClearedAt() };
      const merged = mergeSyncState(local, server);
      applyMergedState(merged, local);
      let finalState = merged;
      if (!sameEventList(merged.events, server.events) || !sameDeletedMap(merged.deleted, server.deleted) || (merged.clearedAt || '') !== (server.clearedAt || '')) {
        const pushed = await syncPush(merged);
        if (pushed) {
          finalState = pushed;
          applyMergedState(pushed, merged);
        }
      }
      setSyncStatus('ok');
      return true;
    } catch (e) {
      setSyncStatus('error', e.message || 'Sincronizzazione non riuscita. Riprovo al prossimo controllo.');
      return false;
    }
  }

  function syncFromServerOnStartup() {
    enqueueSync(syncOnce);
  }

  function startSyncPollingLoop() {
    setInterval(() => {
      if (document.hidden) return;
      enqueueSync(syncOnce);
    }, 30000);
    window.addEventListener('online', () => { setSyncStatus('pending'); enqueueSync(syncOnce); });
    window.addEventListener('offline', updateSyncStatusUi);
  }

  /* ---------------------------------------------------------------------
     0. STORAGE MODULE
     --------------------------------------------------------------------- */
  const STORAGE_EVENTS_KEY = 'tr_events';
  const STORAGE_SETTINGS_KEY = 'tr_settings';
  const STORAGE_DELETED_KEY = 'tr_deleted';
  const STORAGE_CLEARED_KEY = 'tr_cleared_at';
  const STORAGE_BACKUP_KEY = 'tr_last_local_backup';

  const DEFAULT_SETTINGS = { notificationsEnabled: false, timeZone: 'Europe/Rome' };

  const Storage = {
    getEvents() {
      try {
        const raw = localStorage.getItem(STORAGE_EVENTS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
        const normalized = Core.normalizeState({ events: list });
        if (normalized.events.length !== list.length) {
          try { localStorage.setItem('tr_events_corrupt', raw); } catch (e) { /* memoria piena */ }
          console.warn('Alcuni incarichi non validi o duplicati sono stati esclusi.');
        }
        return normalized.events;
      } catch (e) {
        const raw = localStorage.getItem(STORAGE_EVENTS_KEY);
        if (raw) { try { localStorage.setItem('tr_events_corrupt', raw); } catch (ignore) { /* memoria piena */ } }
        console.error('Errore lettura tr_events', e);
        return [];
      }
    },
    getDeleted() {
      try {
        const raw = localStorage.getItem(STORAGE_DELETED_KEY);
        const map = raw ? JSON.parse(raw) : {};
        return Core.normalizeState({ events: [], deleted: map }).deleted;
      } catch (e) {
        console.error('Errore lettura tr_deleted', e);
        return {};
      }
    },
    getClearedAt() {
      const value = localStorage.getItem(STORAGE_CLEARED_KEY) || '';
      return Core.isValidIso(value) ? value : '';
    },
    saveEvents(events, opts) {
      try {
        localStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(events));
      } catch (e) {
        showToast('Impossibile salvare: memoria del dispositivo piena o non disponibile.');
        return false;
      }
      if (!(opts && opts.skipSync)) {
        setSyncStatus('pending');
        enqueueSync(syncOnce);
      }
      return true;
    },
    addEvent(evt) {
      evt.updatedAt = new Date().toISOString();
      if (!Core.validateEvent(evt)) { showToast('Dati dell’incarico non validi'); return null; }
      const events = Storage.getEvents();
      events.push(evt);
      return Storage.saveEvents(events) ? evt : null;
    },
    updateEvent(id, patch) {
      const events = Storage.getEvents();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return null;
      patch.updatedAt = new Date().toISOString();
      events[idx] = Object.assign({}, events[idx], patch);
      if (!Core.validateEvent(events[idx])) { showToast('Dati dell’incarico non validi'); return null; }
      return Storage.saveEvents(events) ? events[idx] : null;
    },
    deleteEvent(id) {
      const events = Storage.getEvents().filter((e) => e.id !== id);
      // Tombstone: senza, il prossimo merge con il server "risusciterebbe" l'evento eliminato.
      const deleted = Storage.getDeleted();
      deleted[id] = new Date().toISOString();
      try { localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(deleted)); } catch (e) { return false; }
      return Storage.saveEvents(events);
    },
    undeleteEvent(evt) {
      if (!evt) return false;
      const deleted = Storage.getDeleted();
      delete deleted[evt.id];
      try { localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(deleted)); } catch (e) { return false; }
      evt.updatedAt = new Date(Date.now() + 1).toISOString();
      return Storage.addEvent(evt);
    },
    // "Cancella tutti i dati": elimina tutto anche sugli altri dispositivi (tombstone per ogni evento).
    deleteAll() {
      const previous = { events: Storage.getEvents(), deleted: Storage.getDeleted(), clearedAt: Storage.getClearedAt() };
      try { localStorage.setItem(STORAGE_BACKUP_KEY, JSON.stringify(Core.makeBackup(previous, 'pre-clear'))); } catch (e) { /* backup server tentato separatamente */ }
      const deleted = Storage.getDeleted();
      const now = new Date().toISOString();
      previous.events.forEach((e) => { deleted[e.id] = now; });
      try {
        localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(deleted));
        localStorage.setItem(STORAGE_CLEARED_KEY, now);
      } catch (e) {
        showToast('Impossibile aggiornare lo stato di cancellazione.');
        return false;
      }
      return Storage.saveEvents([]);
    },
    getSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return Object.assign({}, DEFAULT_SETTINGS, parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        console.error('Errore lettura tr_settings', e);
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    },
    saveSettings(settings) {
      try { localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings)); return true; }
      catch (e) { showToast('Impossibile salvare le impostazioni.'); return false; }
    },
    updateSettings(patch) {
      const settings = Object.assign({}, Storage.getSettings(), patch);
      return Storage.saveSettings(settings) ? settings : Storage.getSettings();
    },
    exportState() {
      return Core.makeBackup({ events: Storage.getEvents(), deleted: Storage.getDeleted(), clearedAt: Storage.getClearedAt() }, 'device');
    }
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Come escapeHtml, ma sicuro anche dentro un attributo value="..." (fa l'escape anche delle virgolette).
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------------------
     1. NAVIGATION
     --------------------------------------------------------------------- */
  function initNavigation() {
    const navButtons = document.querySelectorAll('[data-nav-target]');
    navButtons.forEach((btn) => {
      btn.addEventListener('click', () => navigateTo(btn.getAttribute('data-nav-target')));
    });
    const search = document.getElementById('calendar-search');
    if (search) search.addEventListener('input', () => { if (calendarInstance) renderCalendar(); });
  }

  function navigateTo(viewId) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
    document.querySelectorAll('.nav-btn').forEach((b) => {
      const active = b.getAttribute('data-nav-target') === viewId;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (viewId === 'view-calendar') renderCalendar();
    if (viewId === 'view-stats') renderStats();
    if (viewId === 'view-dashboard') renderDashboard();
  }

  /* ---------------------------------------------------------------------
     2. TOAST
     --------------------------------------------------------------------- */
  let toastTimer = null;
  // actionLabel/actionFn opzionali: aggiunge un pulsante dentro il toast (es. "Annulla" dopo
  // un'eliminazione). Resta visibile più a lungo quando c'è un'azione, per dare il tempo di cliccarla.
  function showToast(msg, actionLabel, actionFn) {
    const toast = document.getElementById('toast');
    toast.innerHTML = '';

    const textEl = document.createElement('span');
    textEl.textContent = msg;
    toast.appendChild(textEl);

    if (actionLabel && actionFn) {
      const actionBtn = document.createElement('button');
      actionBtn.className = 'toast-action';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', () => {
        clearTimeout(toastTimer);
        toast.classList.remove('show');
        actionFn();
      });
      toast.appendChild(actionBtn);
    }

    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), actionLabel ? 5000 : 2500);
  }

  /* ---------------------------------------------------------------------
     3. DASHBOARD
     --------------------------------------------------------------------- */
  function formatDateIt(dateStr, timeStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T' + (timeStr || '00:00'));
    const opts = { weekday: 'short', day: 'numeric', month: 'short' };
    const dateLabel = d.toLocaleDateString('it-IT', opts);
    return timeStr ? `${dateLabel}, ${timeStr}` : dateLabel;
  }

  function getUpcomingEvents(limit) {
    // Confronto per giorno (non per data+ora esatta): un incarico di "oggi" deve restare visibile
    // anche se l'orario indicato è già passato, o se non ha un orario (mezzanotte sarebbe già "nel
    // passato" rispetto ad ora, facendolo sparire per errore dai "prossimi incarichi").
    const todayStr = isoDate(new Date());
    return Storage.getEvents()
      .filter((e) => e.date >= todayStr)
      .sort((a, b) => {
        const da = new Date(a.date + 'T' + (a.time || '00:00'));
        const db = new Date(b.date + 'T' + (b.time || '00:00'));
        return da - db;
      })
      .slice(0, limit || 5);
  }

  // Incarichi che cadono nello stesso giorno: capita facilmente importando più PDF diversi,
  // e vale la pena segnalarlo subito invece di scoprirlo per caso guardando il calendario.
  function findSameDayConflicts(events) {
    const byDate = {};
    events.forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
    return Object.entries(byDate)
      .filter(([, list]) => list.length >= 2)
      .map(([date, list]) => ({ date, events: list }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Da chiamare subito dopo aver salvato un incarico: se quel giorno ce n'è già un altro,
  // avvisa con un toast invece del solito "salvato" (la Dashboard mostra comunque l'elenco completo).
  function warnIfSameDayConflict(evt) {
    const sameDay = Storage.getEvents().filter((e) => e.date === evt.date);
    if (sameDay.length >= 2) {
      showToast(`Hai più incarichi il ${formatDateIt(evt.date)}`);
      return true;
    }
    return false;
  }

  function renderConflictWarning(events) {
    const wrap = document.getElementById('conflict-warning-wrap');
    const list = document.getElementById('conflict-list');
    const conflicts = findSameDayConflicts(events);
    if (conflicts.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    list.innerHTML = conflicts.map((c) => {
      const titles = c.events.map((e) => escapeHtml(e.title)).join(', ');
      return `<p class="small-text"><strong>${formatDateIt(c.date)}</strong>: ${titles}</p>`;
    }).join('');
  }

  function renderDashboard() {
    const events = Storage.getEvents();
    const currentYear = new Date().getFullYear();
    const yearEvents = events.filter((e) => Number(e.date.slice(0, 4)) === currentYear);
    document.getElementById('stat-year-total').textContent = yearEvents.length;

    const roleCounts = {};
    events.forEach((e) => { roleCounts[e.title] = (roleCounts[e.title] || 0) + 1; });
    let topRole = '—';
    let topCount = 0;
    Object.entries(roleCounts).forEach(([role, count]) => {
      if (count > topCount) { topRole = role; topCount = count; }
    });
    document.getElementById('stat-top-role').textContent = topRole;

    renderConflictWarning(events);

    const upcoming = getUpcomingEvents(5);
    const listEl = document.getElementById('upcoming-list');
    listEl.innerHTML = '';
    if (upcoming.length === 0) {
      listEl.innerHTML = `<div class="empty-state">Nessun incarico in programma.<br>Carica un PDF per iniziare.</div>`;
      return;
    }
    upcoming.forEach((evt) => {
      const card = document.createElement('article');
      card.className = 'card assignment-card upcoming-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', 'Apri ' + evt.title + ', ' + formatDateIt(evt.date, evt.time));
      card.innerHTML = `
        <span class="badge">${escapeHtml(evt.title)}</span>
        <div class="card-row">
          <strong>${formatDateIt(evt.date, evt.time)}</strong>
        </div>
        ${evt.description ? `<p class="small-text">${escapeHtml(evt.description)}</p>` : ''}
      `;
      const open = () => openEventModal(evt.id);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      listEl.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------------
     4. CALENDARIO (FullCalendar)
     --------------------------------------------------------------------- */
  let calendarInstance = null;

  function renderCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl) return;
    if (typeof FullCalendar === 'undefined') {
      calendarEl.innerHTML = '<div class="empty-state">Calendario non disponibile. Riapri l’app con una connessione internet.</div>';
      return;
    }

    const query = (document.getElementById('calendar-search').value || '').trim().toLowerCase();
    const events = Storage.getEvents()
      .filter((e) => !query || (e.title + ' ' + (e.description || '')).toLowerCase().includes(query))
      .map((e) => ({
        id: e.id,
        title: e.title,
        start: e.time ? `${e.date}T${e.time}` : e.date,
        allDay: !e.time,
        extendedProps: { description: e.description || '' }
      }));

    if (calendarInstance) {
      calendarInstance.removeAllEvents();
      calendarInstance.addEventSource(events);
      calendarInstance.render();
      return;
    }

    calendarInstance = new FullCalendar.Calendar(calendarEl, {
      initialView: window.matchMedia('(max-width: 599px)').matches ? 'listMonth' : 'dayGridMonth',
      locale: {
        code: 'it', week: { dow: 1, doy: 4 },
        buttonText: { prev: 'Prec', next: 'Succ', today: 'Oggi', year: 'Anno', month: 'Mese', week: 'Settimana', day: 'Giorno', list: 'Agenda' },
        weekText: 'Sm', allDayText: 'Tutto il giorno',
        moreLinkText: (n) => '+altri ' + n,
        noEventsText: 'Nessun incarico da visualizzare'
      },
      firstDay: 1, // settimana da lunedì a domenica
      height: 'auto',
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,listMonth' },
      events: events,
      editable: true, // tieni premuto e trascina un incarico su un'altra data
      longPressDelay: 350, // sui touch, "tenere premuto" per iniziare il trascinamento
      eventClick: (info) => openEventModal(info.event.id),
      eventDrop: (info) => {
        // Nuova data trascinata: apri subito il popup di modifica per confermare/correggere
        // (invece di salvare in silenzio), con possibilità di annullare e tornare alla data originale.
        const newDate = info.event.startStr.slice(0, 10);
        openEventModal(info.event.id, newDate, () => info.revert());
      },
      dateClick: (info) => openEventModal(null, info.dateStr) // click su un giorno vuoto → nuovo incarico
    });
    calendarInstance.render();
  }

  /* ---------------------------------------------------------------------
     5. MODIFICA INCARICO (popup condiviso: click sul calendario o trascinamento)
     --------------------------------------------------------------------- */
  let editingEventId = null;
  let editingEventOriginal = null; // per capire se data/promemoria sono davvero cambiati al salvataggio
  let editingRevertFn = null; // se aperto da un trascinamento: riporta l'evento alla data originale se annulli
  let lastFocusedElement = null;
  let pendingEventId = '';

  function openEventModal(eventId, overrideDate, revertFn) {
    // eventId nullo → modalità "nuovo incarico" (aperta dal bottone "+" o da un click su un
    // giorno vuoto del calendario), altrimenti modalità modifica di un incarico esistente.
    const isNew = !eventId;
    const evt = isNew ? null : Storage.getEvents().find((e) => e.id === eventId);
    if (!isNew && !evt) return;

    editingEventId = isNew ? null : eventId;
    editingEventOriginal = evt;
    editingRevertFn = revertFn || null;
    lastFocusedElement = document.activeElement;

    document.getElementById('modal-title-input').value = evt ? evt.title : '';
    document.getElementById('modal-date-input').value = overrideDate || (evt ? evt.date : isoDate(new Date()));
    document.getElementById('modal-time-input').value = evt ? (evt.time || '') : '';
    document.getElementById('modal-desc-input').value = evt ? (evt.description || '') : '';

    const reminderType = evt ? ((evt.reminder && evt.reminder.type) || '1day') : '1day';
    document.getElementById('modal-reminder-input').value = reminderType;
    const customDaysInput = document.getElementById('modal-reminder-custom-days');
    customDaysInput.value = evt ? ((evt.reminder && evt.reminder.customDays) || '') : '';
    customDaysInput.classList.toggle('hidden', reminderType !== 'custom');

    document.getElementById('modal-heading').textContent = isNew ? 'Nuovo incarico' : 'Modifica incarico';
    document.getElementById('modal-delete-btn').classList.toggle('hidden', isNew);

    document.getElementById('event-modal').classList.remove('hidden');
    document.getElementById('modal-title-input').focus();
  }

  function openPendingEvent() {
    if (!pendingEventId) return;
    const id = pendingEventId;
    pendingEventId = '';
    if (Storage.getEvents().some((e) => e.id === id)) openEventModal(id);
  }

  function closeEventModal() {
    document.getElementById('event-modal').classList.add('hidden');
    // Chiuso senza salvare dopo un trascinamento: l'evento torna alla data originale nel calendario.
    if (editingRevertFn) editingRevertFn();
    editingEventId = null;
    editingEventOriginal = null;
    editingRevertFn = null;
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
    lastFocusedElement = null;
  }

  function saveEventModal() {
    const dateVal = document.getElementById('modal-date-input').value;
    if (!dateVal) {
      showToast('Inserisci una data valida');
      return;
    }
    const reminderType = document.getElementById('modal-reminder-input').value;
    const customDaysInput = document.getElementById('modal-reminder-custom-days');
    const customDays = parseInt(customDaysInput.value, 10);
    if (reminderType === 'custom' && (!Number.isInteger(customDays) || customDays < 1 || customDays > 3650)) {
      showToast('Inserisci almeno 1 giorno per il promemoria personalizzato');
      customDaysInput.focus();
      return;
    }

    const patch = {
      title: document.getElementById('modal-title-input').value.trim() || 'Altro',
      date: dateVal,
      time: document.getElementById('modal-time-input').value || '',
      description: document.getElementById('modal-desc-input').value || '',
      reminder: {
        type: reminderType,
        customDays: reminderType === 'custom' ? customDays : null
      }
    };

    let saved;
    if (editingEventId) {
      // Modifica di un incarico esistente. Se data/ora/promemoria sono cambiati, il promemoria
      // va ricalcolato da capo (anche se era già scattato per la vecchia data).
      const orig = editingEventOriginal;
      const dateOrTimeChanged = !orig || orig.date !== patch.date || orig.time !== patch.time;
      const reminderChanged = !orig || JSON.stringify(orig.reminder) !== JSON.stringify(patch.reminder);
      if (dateOrTimeChanged || reminderChanged) {
        patch.reminderFired = false;
        patch.reminderFiredAt = null; // azzerato anche lui: così la finestra anti-doppia notifica riparte
      }
      saved = Storage.updateEvent(editingEventId, patch);
    } else {
      // Nuovo incarico aggiunto a mano dal calendario (nessun PDF di origine).
      saved = Object.assign({
        id: uuid(),
        sourcePdf: null,
        reminderFired: false,
        createdAt: new Date().toISOString()
      }, patch);
      saved = Storage.addEvent(saved);
    }

    if (!saved) return;
    if (saved) {
      clearTimeout(reminderTimers[saved.id]);
      scheduleReminderForEvent(saved);
    }

    editingRevertFn = null; // il nuovo posto è confermato, non serve più tornare indietro
    document.getElementById('event-modal').classList.add('hidden');
    editingEventId = null;
    editingEventOriginal = null;
    if (lastFocusedElement && document.contains(lastFocusedElement)) lastFocusedElement.focus();
    lastFocusedElement = null;
    renderCalendar();
    renderDashboard();
    if (saved && !warnIfSameDayConflict(saved)) showToast('Incarico salvato');
  }

  function initModal() {
    document.getElementById('modal-close-btn').addEventListener('click', closeEventModal);
    document.getElementById('event-modal').addEventListener('click', (e) => {
      if (e.target.id === 'event-modal') closeEventModal();
    });
    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('event-modal');
      if (modal.classList.contains('hidden')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeEventModal(); return; }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll('button, input, select, textarea, [tabindex="0"]')).filter((el) => !el.disabled && !el.classList.contains('hidden'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    const reminderSelect = document.getElementById('modal-reminder-input');
    const customDaysInput = document.getElementById('modal-reminder-custom-days');
    reminderSelect.addEventListener('change', () => {
      customDaysInput.classList.toggle('hidden', reminderSelect.value !== 'custom');
    });

    document.getElementById('modal-save-btn').addEventListener('click', saveEventModal);
    document.getElementById('add-event-btn').addEventListener('click', () => openEventModal(null));

    document.getElementById('modal-delete-btn').addEventListener('click', () => {
      if (!editingEventId) return;
      // Elimina subito (nessun popup di conferma): il toast con "Annulla" dà qualche secondo
      // per ripensarci, senza bloccare il flusso con una domanda ogni volta.
      const deletedEvent = Storage.getEvents().find((e) => e.id === editingEventId);
      Storage.deleteEvent(editingEventId);
      editingRevertFn = null; // eliminato volutamente: non riportarlo alla vecchia data
      document.getElementById('event-modal').classList.add('hidden');
      editingEventId = null;
      editingEventOriginal = null;
      renderCalendar();
      renderDashboard();
      showToast('Incarico eliminato', 'Annulla', () => {
        if (!deletedEvent) return;
        const restored = Storage.undeleteEvent(deletedEvent);
        if (!restored) return;
        scheduleReminderForEvent(restored);
        renderCalendar();
        renderDashboard();
        showToast('Incarico ripristinato');
      });
    });
  }

  // Click su un'anteprima PDF (generata dinamicamente) → la mostra ingrandita in un lightbox.
  function initSnippetLightbox() {
    const overlay = document.getElementById('image-lightbox');
    const img = document.getElementById('lightbox-img');
    let lastFocused = null;
    const close = () => {
      overlay.classList.add('hidden');
      if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
      lastFocused = null;
    };
    document.addEventListener('click', (e) => {
      const snippet = e.target.closest('.pdf-snippet');
      if (snippet && snippet.src && !snippet.classList.contains('snippet-loading')) {
        lastFocused = document.activeElement;
        img.src = snippet.src;
        overlay.classList.remove('hidden');
        document.getElementById('lightbox-close-btn').focus();
      }
    });
    document.getElementById('lightbox-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
  }

  /* ---------------------------------------------------------------------
     6. UPLOAD PDF + ESTRAZIONE INCARICHI DI "Piano"
     --------------------------------------------------------------------- */

  // Cerchiamo solo il cognome "Piano" (maiuscolo, non "piano" minuscolo che è anche una comune
  // parola italiana): è l'unico cognome di questo tipo nei programmi della congregazione, quindi
  // non serve più cercare "Matteo Piano" per intero. L'unica altra persona con lo stesso cognome
  // nei documenti è "Ester Piano": la escludiamo esplicitamente.
  function isPianoLine(line) {
    return /\bPiano\b/.test(line) && !/\bEster\b/i.test(line);
  }
  function isPianoToken(str) {
    const s = (str || '').trim();
    return /\bPiano\b/.test(s) && !/\bEster\b/i.test(s);
  }

  let uploadCardCounter = 0;
  let isProcessingPdf = false;
  let lastImportedIds = [];

  function initPdfUpload() {
    const input = document.getElementById('pdfInput');
    const dropZone = document.getElementById('pdf-drop-zone');

    input.addEventListener('change', (e) => handleFiles(e.target.files));

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });

    document.getElementById('save-all-assignments-btn').addEventListener('click', () => {
      lastImportedIds = [];
      const buttons = Array.from(document.querySelectorAll('#assignments-list .assignment-card button')).filter((b) => !b.disabled);
      buttons.forEach((button) => button.click());
      if (!lastImportedIds.length) { showToast('Nessun nuovo incarico da salvare'); return; }
      const ids = lastImportedIds.slice();
      showToast(`${ids.length} incarichi salvati`, 'Annulla', () => {
        ids.forEach((id) => Storage.deleteEvent(id));
        renderCalendar();
        renderDashboard();
        showToast('Importazione annullata');
      });
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );
    if (files.length === 0) return;
    if (isProcessingPdf) { showToast('Attendi che l’elaborazione dei PDF sia terminata'); return; }
    if (files.length > 20 || files.some((f) => f.size > 50 * 1024 * 1024)) {
      showToast('Massimo 20 file e 50 MB per ogni PDF');
      return;
    }
    isProcessingPdf = true;
    document.getElementById('pdfInput').disabled = true;
    document.getElementById('pdf-drop-zone').setAttribute('aria-busy', 'true');

    const statusEl = document.getElementById('pdf-status');
    statusEl.classList.remove('hidden');
    document.getElementById('assignments-wrap').classList.remove('hidden');
    document.getElementById('pdf-preview-wrap').classList.remove('hidden');

    const list = document.getElementById('assignments-list');
    list.innerHTML = '';
    uploadCardCounter = 0;

    const previewChunks = [];
    let totalMatches = 0;

    for (const file of files) {
      statusEl.textContent = `Estrazione in corso: ${file.name}…`;
      const section = document.createElement('div');
      section.className = 'pdf-file-section';
      list.appendChild(section);

      try {
        const { fullText, pages, pdf } = await extractPdfText(file);
        previewChunks.push(`===== ${file.name} =====\n${fullText}`);
        const matches = findAssignments(pages, file.name);
        totalMatches += matches.length;
        const pairs = renderFileSection(section, file.name, matches);
        // Le anteprime visive si generano in background (non blocca l'elaborazione degli altri file).
        generateSnippetsAsync(pdf, pairs);
      } catch (err) {
        console.error(err);
        section.innerHTML = `<h4>${escapeHtml(file.name)}</h4><p class="small-text">Errore durante la lettura di questo PDF: ${escapeHtml(err.message)}</p>`;
      }
    }

    document.getElementById('pdf-preview').value = previewChunks.join('\n\n');
    statusEl.textContent = `${files.length} file elaborati, ${totalMatches} incaric${totalMatches === 1 ? 'o' : 'hi'} individuat${totalMatches === 1 ? 'o' : 'i'}.`;
    isProcessingPdf = false;
    document.getElementById('pdfInput').disabled = false;
    document.getElementById('pdfInput').value = '';
    document.getElementById('pdf-drop-zone').removeAttribute('aria-busy');
  }

  async function extractPdfText(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('Libreria pdf.js non disponibile (controlla la connessione internet).');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf-3.11.174.pdf.worker.min.js';

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    let fullText = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const rawItems = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }));
      // Raggruppa gli item per riga approssimata usando la coordinata Y, mantenendo anche il
      // rettangolo (minX/maxX/y) di ogni riga: serve dopo per ritagliare l'anteprima visiva dal PDF.
      const rows = groupTextItemsIntoRows(content.items);
      const lines = rows.map((r) => r.text);
      const lineBoxes = rows.map((r) => ({ minX: r.minX, maxX: r.maxX, y: r.y }));
      pages.push({ pageNum, lines, lineBoxes, rawItems });
      fullText += lines.join('\n') + '\n\n';
    }
    return { fullText: fullText.trim(), pages, pdf };
  }

  function groupTextItemsIntoRows(items) {
    // pdf.js non garantisce l'ordine riga per riga: raggruppiamo per coordinata Y (best effort).
    const rows = [];
    const tolerance = 3;
    items.forEach((item) => {
      const y = item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= tolerance);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push(item);
    });
    rows.sort((a, b) => b.y - a.y); // dall'alto verso il basso
    return rows.map((row) => {
      row.items.sort((a, b) => a.transform[4] - b.transform[4]); // sinistra -> destra
      const text = row.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      const minX = Math.min(...row.items.map((i) => i.transform[4]));
      const maxX = Math.max(...row.items.map((i) => i.transform[4] + (i.width || 0)));
      return { text, minX, maxX, y: row.y };
    }).filter((r) => r.text);
  }

  /* ----- 5-img. Anteprima visiva: ritaglia dal PDF la parte in cui è stato letto un dato -----
     Renderizziamo la pagina una sola volta (e la teniamo in cache per pagina) poi ne ritagliamo
     i pixel corrispondenti al rettangolo PDF di ciascuna "fascia" (snippetStrips), componendole
     una sopra l'altra in un'unica immagine compatta con il dato letto evidenziato. */
  function pdfBoxToPixelRect(viewport, box) {
    const corners = [
      viewport.convertToViewportPoint(box.minX, box.minY),
      viewport.convertToViewportPoint(box.maxX, box.minY),
      viewport.convertToViewportPoint(box.minX, box.maxY),
      viewport.convertToViewportPoint(box.maxX, box.maxY)
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  function clampRect(rect, canvas) {
    let { x, y, width, height } = rect;
    if (x < 0) { width += x; x = 0; }
    if (y < 0) { height += y; y = 0; }
    if (x + width > canvas.width) width = canvas.width - x;
    if (y + height > canvas.height) height = canvas.height - y;
    return { x, y, width: Math.max(1, width), height: Math.max(1, height) };
  }

  function drawRoundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const pageCanvasCache = new Map(); // cache limitata: le canvas full-page pesano molto sui telefoni
  const PAGE_CACHE_LIMIT = 6;

  async function getRenderedPage(pdf, pageNum) {
    const cacheKey = (pdf.__trId || (pdf.__trId = uuid())) + ':' + pageNum;
    if (pageCanvasCache.has(cacheKey)) return pageCanvasCache.get(cacheKey);
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const result = { canvas, viewport };
    pageCanvasCache.set(cacheKey, result);
    while (pageCanvasCache.size > PAGE_CACHE_LIMIT) pageCanvasCache.delete(pageCanvasCache.keys().next().value);
    return result;
  }

  async function buildSnippetDataUrl(pdf, pageNum, strips) {
    const { canvas: fullCanvas, viewport } = await getRenderedPage(pdf, pageNum);

    const targetWidth = 640;
    const gap = 6;
    const pad = 10;

    const stripRects = strips.map(({ box }) => clampRect(pdfBoxToPixelRect(viewport, box), fullCanvas));
    const commonSrcWidth = Math.max(...stripRects.map((r) => r.width));
    const scaleOut = targetWidth / commonSrcWidth;
    const outHeights = stripRects.map((r) => Math.max(1, Math.round(r.height * scaleOut)));
    const totalHeight = outHeights.reduce((a, b) => a + b, 0) + gap * (strips.length - 1) + pad * 2;

    const out = document.createElement('canvas');
    out.width = targetWidth + pad * 2;
    out.height = totalHeight;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);

    let cursorY = pad;
    strips.forEach((strip, i) => {
      const rect = stripRects[i];
      const destH = outHeights[i];
      ctx.drawImage(fullCanvas, rect.x, rect.y, rect.width, rect.height, pad, cursorY, targetWidth, destH);

      if (strip.highlight) {
        const hRect = clampRect(pdfBoxToPixelRect(viewport, strip.highlight), fullCanvas);
        const relX = (hRect.x - rect.x) * scaleOut;
        const relY = (hRect.y - rect.y) * scaleOut;
        const hw = hRect.width * scaleOut;
        const hh = hRect.height * scaleOut;
        ctx.save();
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 3;
        ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
        drawRoundedRect(ctx, pad + relX - 4, cursorY + relY - 3, hw + 8, hh + 6, 5);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      cursorY += destH + gap;
    });

    return out.toDataURL('image/png');
  }

  async function generateSnippetsAsync(pdf, pairs) {
    const queue = pairs.filter(({ match, imgEl }) => imgEl && match.snippetStrips && match.snippetStrips.length);
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const { match, imgEl } = queue[cursor++];
        try {
          const dataUrl = await buildSnippetDataUrl(pdf, match.pageNum, match.snippetStrips);
          imgEl.src = dataUrl;
          imgEl.classList.remove('snippet-loading');
        } catch (err) {
          console.error('Errore nella generazione dell\'anteprima PDF', err);
          const wrap = imgEl.closest('.pdf-snippet-wrap');
          if (wrap) wrap.classList.add('hidden');
        }
      }
    }
    await Promise.all([worker(), worker()]);
    for (const key of [...pageCanvasCache.keys()]) if (key.startsWith(pdf.__trId + ':')) pageCanvasCache.delete(key);
    if (pdf.destroy) await pdf.destroy().catch(() => {});
  }

  /* ----- 5a. Estrazione a colonne (Video/Mixer/Mic+PODIO/Microfono/Sala/Porta/Esterno) -----
     In "Programma Incarichi Adunanze Pubbliche" i ruoli sono organizzati in colonne verticali:
     usiamo le coordinate x/y dei singoli elementi di testo (non le righe già raggruppate) per
     abbinare ogni occorrenza di "Piano" alla colonna/ruolo e alla data più vicine. */
  const COLUMN_ROLE_LABELS = [
    { label: 'Video', re: /^Video$/i },
    { label: 'Mixer', re: /^Mixer$/i },
    { label: 'Mic + PODIO', re: /^Mic\s*\+\s*PODIO$/i },
    { label: 'Microfono', re: /^Microfono$/i },
    { label: 'Sala', re: /^Sala$/i },
    { label: 'Porta', re: /^Porta$/i },
    { label: 'Esterno', re: /^Esterno$/i }
  ];

  function nearestBy(list, key, val) {
    let best = null;
    let bestDist = Infinity;
    list.forEach((it) => {
      const d = Math.abs(it[key] - val);
      if (d < bestDist) { bestDist = d; best = it; }
    });
    return best;
  }

  function parseShortDate(str, preferredYear) {
    const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!m) return '';
    const year = preferredYear || new Date().getFullYear();
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  // Altezza approssimativa di una riga di testo attorno alla sua baseline (in punti PDF),
  // usata per ritagliare le anteprime visive dal PDF.
  const ROW_ASCENT = 9;
  const ROW_DESCENT = 3;

  function tryExtractColumnAssignments(rawItems, pageNum, preferredYear) {
    const headerItems = [];
    COLUMN_ROLE_LABELS.forEach(({ label, re }) => {
      const hit = rawItems.find((it) => re.test(it.str.trim()));
      if (hit) headerItems.push({ label, x: hit.x, y: hit.y });
    });
    // Serve una vera intestazione a colonne (almeno 3 etichette note) per fidarsi di questo metodo:
    // altrimenti non è questo tipo di documento, si torna all'estrazione generica riga per riga.
    if (headerItems.length < 3) return null;

    const dateItems = rawItems.filter((it) => /^\d{1,2}\/\d{1,2}$/.test(it.str.trim()));
    if (dateItems.length === 0) return null;

    const pianoItems = rawItems.filter((it) => isPianoToken(it.str));

    const headerY = headerItems.reduce((sum, h) => sum + h.y, 0) / headerItems.length;
    const headerMinX = Math.min(...headerItems.map((h) => h.x)) - 10;
    const headerMaxX = Math.max(...headerItems.map((h) => h.x)) + 90;

    return pianoItems.map((p) => {
      const nearestDate = nearestBy(dateItems, 'y', p.y);
      const nearestHeader = nearestBy(headerItems, 'x', p.x);
      const dateLabel = nearestDate ? nearestDate.str.trim() : '';
      const rowMinX = Math.min(headerMinX, nearestDate ? nearestDate.x - 10 : p.x);
      const rowMaxX = Math.max(headerMaxX, p.x + 60);

      return {
        rawLine: `${nearestHeader ? nearestHeader.label : 'Ruolo sconosciuto'} — settimana del ${dateLabel || '?'}`,
        context: 'Ruolo e data individuati dalla posizione nella tabella (colonna e riga più vicine).',
        guessedDate: parseShortDate(dateLabel, preferredYear),
        guessedTime: '',
        guessedRole: nearestHeader ? nearestHeader.label : 'Altro',
        confidence: nearestHeader && nearestDate ? 'media' : 'bassa',
        pageNum,
        // Due fasce: l'intestazione delle colonne in alto, la riga trovata in basso (evidenziata),
        // così l'anteprima resta compatta anche se la riga è in fondo a una tabella lunga.
        snippetStrips: [
          { box: { minX: rowMinX, maxX: rowMaxX, minY: headerY - ROW_DESCENT, maxY: headerY + ROW_ASCENT }, highlight: null },
          {
            box: { minX: rowMinX, maxX: rowMaxX, minY: p.y - ROW_DESCENT, maxY: p.y + ROW_ASCENT },
            highlight: { minX: p.x - 4, maxX: p.x + 34, minY: p.y - ROW_DESCENT, maxY: p.y + ROW_ASCENT }
          }
        ]
      };
    });
  }

  /* ----- 5b. Estrazione generica riga per riga (tutti gli altri PDF) ----- */

  const MONTHS_MAP = {
    gennaio: '01', febbraio: '02', marzo: '03', aprile: '04', maggio: '05', giugno: '06',
    luglio: '07', agosto: '08', settembre: '09', ottobre: '10', novembre: '11', dicembre: '12'
  };
  const MONTHS_PATTERN = Object.keys(MONTHS_MAP).join('|');

  const MONTHS_ABBR_MAP = {
    gen: '01', feb: '02', mar: '03', apr: '04', mag: '05', giu: '06',
    lug: '07', ago: '08', set: '09', ott: '10', nov: '11', dic: '12'
  };
  const MONTHS_ABBR_PATTERN = Object.keys(MONTHS_ABBR_MAP).join('|');

  const WEEKDAY_STEMS = [
    { stem: 'domenic', idx: 0 },
    { stem: 'luned', idx: 1 },
    { stem: 'marted', idx: 2 },
    { stem: 'mercoled', idx: 3 },
    { stem: 'gioved', idx: 4 },
    { stem: 'venerd', idx: 5 },
    { stem: 'sabat', idx: 6 }
  ];

  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Usata per PDF che indicano solo un giorno della settimana ricorrente (es. "Orari Adunanze
  // Servizio di Campo": "Sabato h. 15.00 ..."), senza una data specifica: calcoliamo la prossima
  // occorrenza di quel giorno da oggi, così l'utente ha subito una data di partenza da correggere.
  function guessWeekday(text) {
    if (!text) return '';
    const lower = text.toLowerCase();
    for (const { stem, idx } of WEEKDAY_STEMS) {
      if (lower.includes(stem)) {
        const today = new Date();
        const diff = (idx - today.getDay() + 7) % 7;
        const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff);
        return isoDate(next);
      }
    }
    return '';
  }

  function guessDate(text, preferredYear) {
    if (!text) return '';
    const year = preferredYear || new Date().getFullYear();

    // 1. Data numerica: gg/mm/aaaa, gg-mm-aaaa, gg/mm/aa
    const numeric = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (numeric) {
      let [, d, m, y] = numeric;
      if (y.length === 2) y = '20' + y;
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    // 1.5 Data numerica breve senza anno: "27/9", "6/8" (usata in alcune tabelle compatte)
    const shortNumeric = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (shortNumeric) {
      const d = Number(shortNumeric[1]);
      const m = Number(shortNumeric[2]);
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
        return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      }
    }

    // 1.6 Giorno-mese abbreviato: "1-giu", "10-ago" (usato nei programmi del servizio di campo)
    const abbrMatch = text.match(new RegExp('\\b(\\d{1,2})-(' + MONTHS_ABBR_PATTERN + ')\\b', 'i'));
    if (abbrMatch) {
      const day = abbrMatch[1].padStart(2, '0');
      const month = MONTHS_ABBR_MAP[abbrMatch[2].toLowerCase()];
      return `${year}-${month}-${day}`;
    }

    // 2. Intervallo settimanale su due mesi: "31 agosto - 6 settembre" → usa il giorno di inizio
    const crossMonthRange = new RegExp(
      '\\b(\\d{1,2})\\s+(' + MONTHS_PATTERN + ')\\s*-\\s*(\\d{1,2})\\s+(' + MONTHS_PATTERN + ')\\b', 'i'
    );
    const crossMatch = text.match(crossMonthRange);
    if (crossMatch) {
      const day = crossMatch[1].padStart(2, '0');
      const month = MONTHS_MAP[crossMatch[2].toLowerCase()];
      return `${year}-${month}-${day}`;
    }

    // 3. Intervallo settimanale nello stesso mese: "13-19 luglio" → usa il giorno di inizio
    const sameMonthRange = new RegExp('\\b(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s+(' + MONTHS_PATTERN + ')\\b', 'i');
    const rangeMatch = text.match(sameMonthRange);
    if (rangeMatch) {
      const day = rangeMatch[1].padStart(2, '0');
      const month = MONTHS_MAP[rangeMatch[3].toLowerCase()];
      return `${year}-${month}-${day}`;
    }

    // 4. Data singola con mese in lettere: "27 Agosto"
    const singleMatch = text.match(new RegExp('\\b(\\d{1,2})\\s+(' + MONTHS_PATTERN + ')\\b', 'i'));
    if (singleMatch) {
      const day = singleMatch[1].padStart(2, '0');
      const month = MONTHS_MAP[singleMatch[2].toLowerCase()];
      return `${year}-${month}-${day}`;
    }

    return '';
  }

  // Estrae un orario tipo "h. 15.00" / "h 17.00" (usato nel programma del servizio di campo).
  function guessTime(text) {
    if (!text) return '';
    const match = (text || '').match(/\bh\.?\s*(\d{1,2})[.:](\d{2})\b/i);
    if (!match) return '';
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  }

  function guessRoleFromFilename(filename) {
    const lower = (filename || '').toLowerCase();
    if (lower.includes('puliz')) return 'Pulizie';
    if (lower.includes('servizio') && lower.includes('campo')) return 'Servizio di campo';
    return null;
  }

  function guessRole(line, context, filename) {
    // 1. Alcuni PDF riguardano un solo tipo di incarico: nessuna ambiguità possibile.
    const filenameRole = guessRoleFromFilename(filename);
    if (filenameRole) return filenameRole;

    // 2. Scuola di ministero teocratico ("assistente:"/"consigliere:" sulla riga stessa: nel
    //    contesto allargato potrebbero comparire per un'altra parte dell'adunanza vicina).
    if (/consiglier[ei]?\s*:/i.test(line) || /assistente\s*:/i.test(line)) {
      return 'Dimostrazione';
    }

    // 3. "30 min" accanto al nome: conduttore dello studio di libro/congregazione.
    if (/\b30\s*min/i.test(line)) {
      return 'Libro';
    }

    // 4. Etichette di ruolo esplicite nella riga stessa (non nel contesto allargato: righe vicine
    //    non correlate potrebbero contenere "Presidente"/"Lettore"/"Discorso" per un'altra parte
    //    dell'adunanza e non vanno usate come dato, come una parte a due di un altro incarico).
    // Nota: alcuni PDF estraggono "discorso" come "discoro" (manca una lettera per via della
    // codifica dei caratteri nel file originale), quindi cerchiamo solo lo stem "discor".
    if (/\bdiscor/i.test(line)) return 'Discorso';
    const explicit = ['Presidente', 'Lettore'].find((r) => line.toLowerCase().includes(r.toLowerCase()));
    if (explicit) return explicit;

    // 5. Cosa resta della riga tolti "Piano"/"Matteo": se è un'altra persona (Nome Cognome), è
    //    probabilmente una parte a due (dimostrazione); se è una frase, è probabilmente il tema
    //    di un discorso.
    const restOfLine = line.replace(/\bPiano\b/g, '').replace(/\bMatteo\b/gi, '').trim();
    if (restOfLine.length > 8) {
      if (/\b[A-ZÀ-Ý][a-zà-ÿ]+\s+[A-ZÀ-Ý][a-zà-ÿ]+\b/.test(restOfLine)) {
        return 'Dimostrazione';
      }
      return 'Discorso';
    }

    return 'Altro';
  }

  // Alcuni programmi ripetono il nome più volte nella stessa data perché chi presiede l'adunanza
  // introduce anche i cantici e il ripasso del programma della settimana successiva: queste
  // occorrenze non sono incarichi separati, fanno già parte dell'incarico di "Presidente" per
  // quella data (individuato da un'altra occorrenza pulita nello stesso giorno).
  function dedupeSameDateNoise(matches) {
    const byDate = {};
    matches.forEach((m) => {
      if (!m.guessedDate) return;
      (byDate[m.guessedDate] = byDate[m.guessedDate] || []).push(m);
    });

    const toDrop = new Set();
    Object.values(byDate).forEach((group) => {
      if (group.length < 2) return; // la regola si applica solo se il nome è "ripetuto"
      const isNoise = (m) => /\bcantico\b/i.test(m.rawLine) || /\b3\s*min\b/i.test(m.rawLine);
      const noiseMatches = group.filter(isNoise);
      const cleanMatches = group.filter((m) => !isNoise(m));
      if (noiseMatches.length > 0 && cleanMatches.length > 0) {
        noiseMatches.forEach((m) => toDrop.add(m));
      }
    });

    return matches.filter((m) => !toDrop.has(m));
  }

  function rowBand(rowBox) {
    return { minX: rowBox.minX, maxX: rowBox.maxX, minY: rowBox.y - ROW_DESCENT, maxY: rowBox.y + ROW_ASCENT };
  }

  function unionBands(bands) {
    return bands.reduce((acc, b) => ({
      minX: Math.min(acc.minX, b.minX),
      maxX: Math.max(acc.maxX, b.maxX),
      minY: Math.min(acc.minY, b.minY),
      maxY: Math.max(acc.maxY, b.maxY)
    }));
  }

  function findAssignments(pages, filename) {
    const matches = [];
    const preferredYear = Core.guessYearFromFilename(filename);

    pages.forEach(({ pageNum, lines, lineBoxes, rawItems }) => {
      const colMatches = tryExtractColumnAssignments(rawItems, pageNum, preferredYear);
      if (colMatches) {
        matches.push(...colMatches);
        return; // questa pagina è una tabella a colonne; le altre pagine restano riga-per-riga
      }
      const pageText = lines.join(' | ');
      lines.forEach((line, idx) => {
        if (!isPianoLine(line)) return;
        const context = [lines[idx - 2], lines[idx - 1], line, lines[idx + 1], lines[idx + 2]]
          .filter(Boolean).join(' | ');
        const contextIdxs = [idx - 2, idx - 1, idx, idx + 1, idx + 2].filter((i) => i >= 0 && i < lineBoxes.length);
        const exactDate = guessDate(line, preferredYear) || guessWeekday(line);
        const contextDate = guessDate(context, preferredYear) || guessWeekday(context);
        matches.push({
          rawLine: line,
          context,
          guessedDate: exactDate || contextDate || guessDate(pageText, preferredYear),
          guessedTime: guessTime(line) || guessTime(context),
          guessedRole: guessRole(line, context, filename),
          confidence: !exactDate && !contextDate ? 'bassa' : (!guessTime(line) && !guessTime(context) ? 'media' : 'alta'),
          pageNum,
          snippetStrips: [
            { box: unionBands(contextIdxs.map((i) => rowBand(lineBoxes[i]))), highlight: rowBand(lineBoxes[idx]) }
          ]
        });
      });
    });

    return dedupeSameDateNoise(matches);
  }

  function renderFileSection(section, filename, matches) {
    const heading = document.createElement('h4');
    const count = matches.length;
    heading.textContent = `${filename} — ${count} incaric${count === 1 ? 'o' : 'hi'} trovat${count === 1 ? 'o' : 'i'}`;
    section.appendChild(heading);

    if (matches.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'small-text';
      empty.textContent = 'Nessun incarico di Piano individuato in questo file.';
      section.appendChild(empty);
      return [];
    }

    return matches.map((match) => {
      const card = appendAssignmentCard(section, match, filename);
      return { match, imgEl: card.imgEl, save: card.save };
    });
  }

  function appendAssignmentCard(container, match, sourcePdf) {
    const cardId = `assignment-${uploadCardCounter++}`;
    const hasSnippet = !!(match.snippetStrips && match.snippetStrips.length);

    const card = document.createElement('div');
    card.className = 'card assignment-card';
    card.innerHTML = `
      <p class="small-text" style="word-break:break-word;">${escapeHtml(match.rawLine)}</p>
      ${match.confidence === 'bassa' ? '<span class="confidence-badge">Data o ruolo da verificare</span>' : ''}

      <label for="${cardId}-title">Ruolo / incarico</label>
      <input type="text" id="${cardId}-title" value="${escapeAttr(match.guessedRole)}" placeholder="Ruolo o incarico">

      <label for="${cardId}-date">Data</label>
      <input type="date" id="${cardId}-date" value="${match.guessedDate || ''}">

      <label for="${cardId}-time">Ora</label>
      <input type="time" id="${cardId}-time" value="${match.guessedTime || ''}">

      <label for="${cardId}-desc">Note</label>
      <textarea id="${cardId}-desc" placeholder="Dettagli aggiuntivi (opzionale)"></textarea>

      <label for="${cardId}-reminder">Promemoria</label>
      <select id="${cardId}-reminder">
        <option value="none">Nessuno</option>
        <option value="3days">3 giorni prima</option>
        <option value="1day" selected>1 giorno prima</option>
        <option value="custom">Personalizzato</option>
      </select>
      <input type="number" id="${cardId}-custom-days" placeholder="Giorni prima" class="hidden" style="margin-top:8px;" min="1" max="3650">

      ${hasSnippet ? `
      <div class="pdf-snippet-wrap">
        <span class="pdf-snippet-label">Dove è stato letto</span>
        <img class="pdf-snippet snippet-loading" id="${cardId}-snippet" alt="Punto del PDF da cui è stato estratto questo dato, con il testo evidenziato">
      </div>` : ''}

      <button class="btn-primary btn-block" style="margin-top:14px;" id="${cardId}-save">Salva nel calendario</button>
    `;
    container.appendChild(card);

    const reminderSelect = card.querySelector(`#${cardId}-reminder`);
    const customDaysInput = card.querySelector(`#${cardId}-custom-days`);
    reminderSelect.addEventListener('change', () => {
      customDaysInput.classList.toggle('hidden', reminderSelect.value !== 'custom');
    });

    const saveButton = card.querySelector(`#${cardId}-save`);
    const save = () => {
      if (saveButton.disabled) return null;
      const dateVal = card.querySelector(`#${cardId}-date`).value;
      if (!Core.isValidDate(dateVal)) {
        showToast('Inserisci una data valida prima di salvare');
        return null;
      }
      const titleVal = card.querySelector(`#${cardId}-title`).value.trim() || 'Altro';
      const timeVal = card.querySelector(`#${cardId}-time`).value || '';
      const reminderType = reminderSelect.value;
      const customDays = parseInt(customDaysInput.value, 10);
      if (reminderType === 'custom' && (!Number.isInteger(customDays) || customDays < 1 || customDays > 3650)) {
        showToast('Inserisci almeno 1 giorno per il promemoria personalizzato');
        customDaysInput.focus();
        return null;
      }
      const duplicate = Storage.getEvents().some((e) => e.date === dateVal && (e.time || '') === timeVal &&
        e.title.trim().toLowerCase() === titleVal.toLowerCase() && (e.sourcePdf || '') === sourcePdf);
      if (duplicate) {
        showToast('Incarico già presente nel calendario');
        return null;
      }
      const evt = {
        id: uuid(), title: titleVal, date: dateVal, time: timeVal,
        description: card.querySelector(`#${cardId}-desc`).value || '', sourcePdf,
        reminder: { type: reminderType, customDays: reminderType === 'custom' ? customDays : null },
        reminderFired: false, createdAt: new Date().toISOString()
      };
      const saved = Storage.addEvent(evt);
      if (!saved) return null;
      lastImportedIds.push(saved.id);
      scheduleReminderForEvent(saved);
      card.style.opacity = '0.5';
      saveButton.textContent = 'Salvato';
      saveButton.disabled = true;
      renderDashboard();
      return saved;
    };
    saveButton.addEventListener('click', () => {
      const saved = save();
      if (saved && !warnIfSameDayConflict(saved)) showToast('Incarico salvato nel calendario');
    });

    return { imgEl: hasSnippet ? card.querySelector(`#${cardId}-snippet`) : null, save };
  }

  /* ---------------------------------------------------------------------
     7. MOTORE PROMEMORIA / NOTIFICHE
     --------------------------------------------------------------------- */
  const reminderTimers = {}; // eventId -> timeoutId
  const MISSED_WINDOW_MS = 12 * 60 * 60 * 1000;
  const FIRED_DEDUP_MS = 24 * 60 * 60 * 1000;

  function scheduleReminderForEvent(evt) {
    if (!evt || evt.reminderFired || Core.getReminderDays(evt.reminder) == null) return;
    const fireTime = Core.reminderFireTime(evt, Storage.getSettings().timeZone);
    const delay = fireTime - Date.now();
    if (delay < 0) {
      if (delay > -MISSED_WINDOW_MS) fireReminder(evt);
      return;
    }
    if (delay < 24 * 60 * 60 * 1000) {
      clearTimeout(reminderTimers[evt.id]);
      reminderTimers[evt.id] = setTimeout(() => fireReminder(evt), delay);
    }
  }

  async function fireReminder(evt) {
    const current = Storage.getEvents().find((e) => e.id === evt.id);
    if (!current || current.reminderFired) return;
    const firedAt = Date.parse(current.reminderFiredAt || '');
    if (isFinite(firedAt) && Date.now() - firedAt < FIRED_DEDUP_MS) return;
    if (!Storage.getSettings().notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;

    const marked = Storage.updateEvent(current.id, { reminderFired: true, reminderFiredAt: new Date().toISOString() });
    if (!marked) return;
    const shown = await showNotification('Promemoria incarico', `${current.title} — ${formatDateIt(current.date, current.time)}`, { data: { eventId: current.id } });
    if (!shown) Storage.updateEvent(current.id, { reminderFired: false, reminderFiredAt: null });
  }

  async function showNotification(title, body, options) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return false;
    const opts = Object.assign({ body, icon: './icons/icon-192.png', badge: './icons/icon-192.png', data: {} }, options || {});
    if (opts.data && opts.data.eventId) opts.actions = [{ action: 'open', title: 'Apri incarico' }];
    try {
      if (navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.showNotification) { await reg.showNotification(title, opts); return true; }
      }
      new Notification(title, opts);
      return true;
    } catch (e) {
      console.error('Notifica locale non mostrata', e);
      return false;
    }
  }

  /* ---------------------------------------------------------------------
     7bis. WEB PUSH "VERO" (funziona anche ad app chiusa)
     Il motore sopra (setTimeout + polling ogni 25s) mostra le notifiche solo mentre l'app è
     aperta in una scheda. Per ricevere i promemoria anche ad app chiusa, il dispositivo si
     sottoscrive alle notifiche push del browser e la sottoscrizione viene inviata al server
     (api/push-subscribe.js); un Cron Job su Vercel (api/send-reminders.js, vedi vercel.json)
     controlla periodicamente gli incarichi e invia lui le notifiche push quando serve.
     --------------------------------------------------------------------- */
  const VAPID_KEY_ENDPOINT = '/api/vapid-public-key';
  const PUSH_SUBSCRIBE_ENDPOINT = '/api/push-subscribe';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function subscribeToPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const key = getSyncKey();
    if (!key) return false; // serve la password per autenticarsi alle API server
    try {
      const keyRes = await fetchWithTimeout(VAPID_KEY_ENDPOINT, { headers: { 'X-Sync-Key': key } });
      if (!keyRes.ok) return false;
      const { publicKey } = await keyRes.json();
      if (!publicKey) return false;

      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }
      const res = await fetchWithTimeout(PUSH_SUBSCRIBE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sync-Key': key },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
      return res.ok;
    } catch (e) {
      return false; // offline, permesso negato dal sistema, o /api non disponibile (es. test locali senza Vercel)
    }
  }

  async function unsubscribeFromPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return true;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return true;
      const key = getSyncKey();
      if (key) {
        const res = await fetchWithTimeout(PUSH_SUBSCRIBE_ENDPOINT, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Sync-Key': key },
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
        if (!res.ok) return false;
      }
      await sub.unsubscribe();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Ri-registra la sottoscrizione push all'avvio se le notifiche sono già attive (es. dopo che il
  // browser l'ha invalidata, o su un dispositivo dove non è mai stata inviata al server).
  function ensurePushSubscription() {
    if (('Notification' in window) && Notification.permission === 'granted' && Storage.getSettings().notificationsEnabled) {
      subscribeToPush();
    }
  }

  function recalcAllReminders() {
    const events = Storage.getEvents();
    events.forEach((evt) => scheduleReminderForEvent(evt));
  }

  function startReminderPollingLoop() {
    // Controllo periodico ogni 25s: copre sia i delay lunghi (>24.8gg) sia eventuali drift del setTimeout.
    setInterval(() => {
      const settings = Storage.getSettings();
      if (!settings.notificationsEnabled) return;
      const events = Storage.getEvents();
      const now = Date.now();
      events.forEach((evt) => {
        if (Core.isReminderDue(evt, now, MISSED_WINDOW_MS, settings.timeZone)) fireReminder(evt);
      });
    }, 25000);
  }

  function initNotifications() {
    const btn = document.getElementById('enable-notifications-btn');
    const statusEl = document.getElementById('notification-status');

    function isActive() {
      return Notification.permission === 'granted' && Storage.getSettings().notificationsEnabled;
    }

    function updateStatus() {
      if (!('Notification' in window)) {
        statusEl.textContent = 'Le notifiche non sono supportate su questo browser.';
        btn.disabled = true;
        return;
      }
      if (Notification.permission === 'denied') {
        statusEl.textContent = 'Notifiche bloccate dal browser. Abilitale nelle impostazioni del sito.';
        btn.textContent = 'Attiva notifiche';
        return;
      }
      if (isActive()) {
        statusEl.textContent = 'Notifiche attive.';
        btn.textContent = 'Disattiva notifiche';
      } else {
        statusEl.textContent = 'Notifiche non attive.';
        btn.textContent = 'Attiva notifiche';
      }
    }

    btn.addEventListener('click', async () => {
      if (!('Notification' in window)) return;

      if (isActive()) {
        const removed = await unsubscribeFromPush();
        if (!removed) { showToast('Non è stato possibile disattivare il push remoto. Riprova.'); return; }
        Storage.updateSettings({ notificationsEnabled: false });
        showToast('Notifiche disattivate');
        updateStatus();
        return;
      }

      let permission = Notification.permission;
      if (permission !== 'granted') permission = await Notification.requestPermission();
      if (permission === 'granted') {
        Storage.updateSettings({ notificationsEnabled: true });
        recalcAllReminders();
        const pushOk = await subscribeToPush();
        showToast(pushOk ? 'Notifiche attivate' : 'Notifiche locali attive; push remoto non registrato');
        updateStatus();
        if (!pushOk) statusEl.textContent = 'Notifiche locali attive, ma il push remoto non è stato registrato.';
        return;
      } else {
        showToast('Permesso notifiche non concesso');
      }
      updateStatus();
    });

    const testBtn = document.getElementById('test-notification-btn');
    if (testBtn) testBtn.addEventListener('click', async () => {
      if (!('Notification' in window) || Notification.permission !== 'granted') {
        showToast('Concedi prima il permesso alle notifiche');
        return;
      }
      const shown = await showNotification('TheoReminder', 'Le notifiche funzionano correttamente.');
      showToast(shown ? 'Notifica di prova inviata' : 'Notifica non riuscita');
    });

    updateStatus();
  }

  /* ---------------------------------------------------------------------
     8. EXPORT CSV
     --------------------------------------------------------------------- */
  function reminderLabel(reminder) {
    if (!reminder || reminder.type === 'none') return 'Nessuno';
    if (reminder.type === '3days') return '3 giorni prima';
    if (reminder.type === '1day') return '1 giorno prima';
    if (reminder.type === 'custom') return `${reminder.customDays || 0} giorni prima`;
    return '';
  }

  function formatDateCsv(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
  }

  function generateCsv(events) {
    const header = ['Data', 'Ora', 'Ruolo/Incarico', 'Descrizione', 'Promemoria', 'File PDF di origine'];
    const sorted = events.slice().sort((a, b) => {
      const da = new Date(a.date + 'T' + (a.time || '00:00'));
      const db = new Date(b.date + 'T' + (b.time || '00:00'));
      return da - db;
    });
    const rows = sorted.map((e) => [
      formatDateCsv(e.date),
      e.time || '',
      e.title,
      e.description || '',
      reminderLabel(e.reminder),
      e.sourcePdf || ''
    ]);
    // Punto e virgola come separatore + BOM UTF-8: apertura diretta e corretta in Excel italiano.
    const lines = [header, ...rows].map((cols) => cols.map(Core.csvCell).join(';'));
    return '﻿' + lines.join('\r\n');
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const events = Storage.getEvents();
    if (events.length === 0) {
      showToast('Nessun incarico da esportare');
      return;
    }
    const csv = generateCsv(events);
    downloadBlob(csv, 'theoreminder-incarichi.csv', 'text/csv;charset=utf-8;');
    showToast('File CSV scaricato');
  }

  async function createServerBackup() {
    const key = getSyncKey();
    if (!key) return false;
    try {
      const res = await fetchWithTimeout(BACKUPS_ENDPOINT, { method: 'POST', headers: { 'X-Sync-Key': key } });
      if (!res.ok) return false;
      await refreshBackupStatus();
      return true;
    } catch (e) {
      return false;
    }
  }

  async function refreshBackupStatus() {
    const el = document.getElementById('backup-status');
    if (!el) return;
    try {
      const res = await fetchWithTimeout(BACKUPS_ENDPOINT, { headers: { 'X-Sync-Key': getSyncKey() } });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const last = data.lastBackupAt || (data.lastBackup && data.lastBackup.savedAt) || (data.backups && data.backups[0] && data.backups[0].savedAt);
      el.textContent = last ? 'Ultimo backup: ' + new Date(last).toLocaleString('it-IT') : 'Nessun backup cloud ancora disponibile.';
    } catch (e) {
      el.textContent = 'Backup automatico mensile; stato cloud non disponibile.';
    }
  }

  function exportJsonBackup() {
    const backup = Storage.exportState();
    downloadBlob(JSON.stringify(backup, null, 2), 'theoreminder-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    showToast('Backup JSON esportato');
  }

  async function importJsonBackup(file) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('File troppo grande');
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'TheoReminder' || !Array.isArray(data.events)) throw new Error('Backup non valido');
      const incoming = Core.normalizeState(data);
      const local = { events: Storage.getEvents(), deleted: Storage.getDeleted(), clearedAt: Storage.getClearedAt() };
      const merged = Core.mergeStates(local, incoming);
      localStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(merged.events));
      localStorage.setItem(STORAGE_DELETED_KEY, JSON.stringify(merged.deleted));
      localStorage.setItem(STORAGE_CLEARED_KEY, merged.clearedAt || '');
      refreshAllViewsAfterSync();
      enqueueSync(syncOnce);
      showToast(`Backup importato: ${incoming.events.length} incarichi validi`);
    } catch (e) {
      showToast('Importazione fallita: ' + e.message);
    } finally {
      document.getElementById('import-json-input').value = '';
    }
  }

  function initDataTools() {
    document.getElementById('create-backup-btn').addEventListener('click', async () => {
      const ok = await createServerBackup();
      showToast(ok ? 'Backup creato' : 'Backup cloud non riuscito');
    });
    document.getElementById('export-json-btn').addEventListener('click', exportJsonBackup);
    document.getElementById('restore-local-backup-btn').addEventListener('click', () => {
      const raw = localStorage.getItem(STORAGE_BACKUP_KEY);
      if (!raw) return;
      try {
        const backup = JSON.parse(raw);
        const now = new Date().toISOString();
        backup.events = backup.events.map((evt) => Object.assign({}, evt, { updatedAt: now }));
        importJsonBackup(new File([JSON.stringify(backup)], 'backup-locale.json', { type: 'application/json' }));
      } catch (e) {
        showToast('Backup locale non leggibile');
      }
    });
    document.getElementById('restore-local-backup-btn').classList.toggle('hidden', !localStorage.getItem(STORAGE_BACKUP_KEY));
    document.getElementById('import-json-input').addEventListener('change', (e) => importJsonBackup(e.target.files[0]));
    document.getElementById('clear-data-btn').addEventListener('click', async () => {
      if (!confirm('Cancellare TUTTI gli incarichi salvati, anche sugli altri dispositivi?')) return;
      const button = document.getElementById('clear-data-btn');
      button.disabled = true;
      const backupOk = await createServerBackup();
      if (!backupOk && !confirm('Il backup cloud non è riuscito. Cancellare comunque? È stato conservato un backup locale.')) {
        button.disabled = false;
        return;
      }
      const ok = Storage.deleteAll();
      button.disabled = false;
      if (!ok) return;
      renderDashboard();
      renderCalendar();
      renderStats();
      document.getElementById('restore-local-backup-btn').classList.remove('hidden');
      showToast('Dati cancellati');
    });
    if (getSyncKey()) refreshBackupStatus();
  }

  /* ---------------------------------------------------------------------
     9. STATISTICHE
     --------------------------------------------------------------------- */
  const MONTHS_IT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

  function renderBarChart(containerId, dataMap) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    const entries = Object.entries(dataMap);
    if (entries.length === 0) {
      container.innerHTML = '<p class="small-text">Nessun dato disponibile.</p>';
      return;
    }
    const max = Math.max(...entries.map(([, v]) => v), 1);
    entries.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const pct = Math.round((value / max) * 100);
      row.innerHTML = `
        <span>${escapeHtml(label)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span>${value}</span>
      `;
      container.appendChild(row);
    });
  }

  function renderStats() {
    const events = Storage.getEvents();
    document.getElementById('stats-total').textContent = events.length;
    const currentYear = new Date().getFullYear();
    document.getElementById('stats-year').textContent = events.filter(
      (e) => Number(e.date.slice(0, 4)) === currentYear
    ).length;

    const byMonth = {};
    events.forEach((e) => {
      const d = new Date(e.date);
      if (isNaN(d)) return;
      const label = `${MONTHS_IT[d.getMonth()]} ${d.getFullYear()}`;
      byMonth[label] = (byMonth[label] || 0) + 1;
    });
    const sortedMonths = {};
    Object.entries(byMonth).sort(([a], [b]) => {
      const [ma, ya] = a.split(' ');
      const [mb, yb] = b.split(' ');
      return Number(ya) - Number(yb) || MONTHS_IT.indexOf(ma) - MONTHS_IT.indexOf(mb);
    }).forEach(([label, value]) => { sortedMonths[label] = value; });
    renderBarChart('stats-by-month', sortedMonths);

    const byRole = {};
    events.forEach((e) => {
      const role = e.title.trim().replace(/\s+/g, ' ').toLowerCase();
      byRole[role] = (byRole[role] || 0) + 1;
    });
    renderBarChart('stats-by-role', byRole);
  }

  /* ---------------------------------------------------------------------
     10. INIT
     --------------------------------------------------------------------- */
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.error('Registrazione service worker fallita', err);
      });
      // Il service worker ci avvisa se ha dovuto rinnovare da solo la sottoscrizione push
      // (evento pushsubscriptionchange, vedi sw.js): la giriamo subito al server.
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'push-resubscribed') {
          const key = getSyncKey();
          if (!key) return;
          fetchWithTimeout(PUSH_SUBSCRIBE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Sync-Key': key },
            body: JSON.stringify({ subscription: event.data.subscription })
          }).catch(() => {});
        }
      });
    }
  }

  function init() {
    try {
      const status = JSON.parse(localStorage.getItem('tr_sync_status') || '{}');
      lastSyncAt = status.lastSyncAt || '';
      lastSyncError = status.lastSyncError || '';
      pendingSync = !!status.pendingSync;
    } catch (e) { /* stato opzionale */ }
    const eventMatch = location.hash.match(/^#event=(.+)$/);
    if (eventMatch) pendingEventId = decodeURIComponent(eventMatch[1]);

    const headerDate = document.getElementById('header-date');
    if (headerDate) {
      headerDate.textContent = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    }

    initLockScreen();
    initNavigation();
    initModal();
    initSnippetLightbox();
    initPdfUpload();
    initNotifications();
    initSecuritySettings();
    initDataTools();
    registerServiceWorker();

    document.getElementById('export-csv-btn').addEventListener('click', exportCsv);

    renderDashboard();
    recalcAllReminders();
    startReminderPollingLoop();

    // Se il dispositivo era già sbloccato in precedenza, prova subito a sincronizzare;
    // se l'app è ancora bloccata, ci riproverà appena l'utente inserisce la password (vedi initLockScreen).
    syncFromServerOnStartup();
    startSyncPollingLoop();
    updateSyncStatusUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
