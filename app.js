/* ==========================================================================
   TheoReminder — app.js
   Agenda personale incarichi congregazione — Matteo Piano
   Vanilla JS, nessun framework, nessun build step.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     0. STORAGE MODULE
     --------------------------------------------------------------------- */
  const STORAGE_EVENTS_KEY = 'tr_events';
  const STORAGE_SETTINGS_KEY = 'tr_settings';

  const DEFAULT_SETTINGS = { notificationsEnabled: false };

  const Storage = {
    getEvents() {
      try {
        const raw = localStorage.getItem(STORAGE_EVENTS_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.error('Errore lettura tr_events', e);
        return [];
      }
    },
    saveEvents(events) {
      localStorage.setItem(STORAGE_EVENTS_KEY, JSON.stringify(events));
    },
    addEvent(evt) {
      const events = Storage.getEvents();
      events.push(evt);
      Storage.saveEvents(events);
      return evt;
    },
    updateEvent(id, patch) {
      const events = Storage.getEvents();
      const idx = events.findIndex((e) => e.id === id);
      if (idx === -1) return null;
      events[idx] = Object.assign({}, events[idx], patch);
      Storage.saveEvents(events);
      return events[idx];
    },
    deleteEvent(id) {
      const events = Storage.getEvents().filter((e) => e.id !== id);
      Storage.saveEvents(events);
    },
    getSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
        return raw ? Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw)) : Object.assign({}, DEFAULT_SETTINGS);
      } catch (e) {
        console.error('Errore lettura tr_settings', e);
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    },
    saveSettings(settings) {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
    },
    updateSettings(patch) {
      const settings = Object.assign({}, Storage.getSettings(), patch);
      Storage.saveSettings(settings);
      return settings;
    }
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
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
  }

  function navigateTo(viewId) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === viewId));
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-nav-target') === viewId);
    });
    if (viewId === 'view-calendar') renderCalendar();
    if (viewId === 'view-stats') renderStats();
    if (viewId === 'view-dashboard') renderDashboard();
  }

  /* ---------------------------------------------------------------------
     2. TOAST
     --------------------------------------------------------------------- */
  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
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
    const now = new Date();
    return Storage.getEvents()
      .filter((e) => {
        const dt = new Date(e.date + 'T' + (e.time || '00:00'));
        return dt >= now;
      })
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
      showToast(`⚠️ Hai più incarichi il ${formatDateIt(evt.date)}`);
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
    const yearEvents = events.filter((e) => new Date(e.date).getFullYear() === currentYear);
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
      listEl.innerHTML = `<div class="empty-state"><span class="empty-icon">🗓️</span>Nessun incarico in programma.<br>Carica un PDF per iniziare.</div>`;
      return;
    }
    upcoming.forEach((evt) => {
      const card = document.createElement('div');
      card.className = 'card assignment-card';
      card.innerHTML = `
        <span class="badge">${escapeHtml(evt.title)}</span>
        <div class="card-row">
          <strong>${formatDateIt(evt.date, evt.time)}</strong>
        </div>
        ${evt.description ? `<p class="small-text">${escapeHtml(evt.description)}</p>` : ''}
      `;
      listEl.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------------
     4. CALENDARIO (FullCalendar)
     --------------------------------------------------------------------- */
  let calendarInstance = null;

  function renderCalendar() {
    const calendarEl = document.getElementById('calendar');
    if (!calendarEl || typeof FullCalendar === 'undefined') return;

    const events = Storage.getEvents().map((e) => ({
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
      initialView: 'dayGridMonth',
      locale: 'it',
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
      }
    });
    calendarInstance.render();
  }

  /* ---------------------------------------------------------------------
     5. MODIFICA INCARICO (popup condiviso: click sul calendario o trascinamento)
     --------------------------------------------------------------------- */
  let editingEventId = null;
  let editingEventOriginal = null; // per capire se data/promemoria sono davvero cambiati al salvataggio
  let editingRevertFn = null; // se aperto da un trascinamento: riporta l'evento alla data originale se annulli

  function openEventModal(eventId, overrideDate, revertFn) {
    const evt = Storage.getEvents().find((e) => e.id === eventId);
    if (!evt) return;

    editingEventId = eventId;
    editingEventOriginal = evt;
    editingRevertFn = revertFn || null;

    document.getElementById('modal-title-input').value = evt.title;
    document.getElementById('modal-date-input').value = overrideDate || evt.date;
    document.getElementById('modal-time-input').value = evt.time || '';
    document.getElementById('modal-desc-input').value = evt.description || '';

    const reminderType = (evt.reminder && evt.reminder.type) || '1day';
    document.getElementById('modal-reminder-input').value = reminderType;
    const customDaysInput = document.getElementById('modal-reminder-custom-days');
    customDaysInput.value = (evt.reminder && evt.reminder.customDays) || '';
    customDaysInput.classList.toggle('hidden', reminderType !== 'custom');

    document.getElementById('event-modal').classList.remove('hidden');
  }

  function closeEventModal() {
    document.getElementById('event-modal').classList.add('hidden');
    // Chiuso senza salvare dopo un trascinamento: l'evento torna alla data originale nel calendario.
    if (editingRevertFn) editingRevertFn();
    editingEventId = null;
    editingEventOriginal = null;
    editingRevertFn = null;
  }

  function saveEventModal() {
    const dateVal = document.getElementById('modal-date-input').value;
    if (!dateVal) {
      showToast('Inserisci una data valida');
      return;
    }
    const reminderType = document.getElementById('modal-reminder-input').value;
    const customDaysInput = document.getElementById('modal-reminder-custom-days');

    const patch = {
      title: document.getElementById('modal-title-input').value.trim() || 'Altro',
      date: dateVal,
      time: document.getElementById('modal-time-input').value || '',
      description: document.getElementById('modal-desc-input').value || '',
      reminder: {
        type: reminderType,
        customDays: reminderType === 'custom' ? (parseInt(customDaysInput.value, 10) || 0) : null
      }
    };

    // Se data/ora/promemoria sono cambiati, il promemoria va ricalcolato da capo (anche se
    // era già scattato per la vecchia data).
    const orig = editingEventOriginal;
    const dateOrTimeChanged = !orig || orig.date !== patch.date || orig.time !== patch.time;
    const reminderChanged = !orig || JSON.stringify(orig.reminder) !== JSON.stringify(patch.reminder);
    if (dateOrTimeChanged || reminderChanged) patch.reminderFired = false;

    const updated = Storage.updateEvent(editingEventId, patch);
    if (updated) {
      clearTimeout(reminderTimers[editingEventId]);
      scheduleReminderForEvent(updated);
    }

    editingRevertFn = null; // il nuovo posto è confermato, non serve più tornare indietro
    document.getElementById('event-modal').classList.add('hidden');
    editingEventId = null;
    editingEventOriginal = null;
    renderCalendar();
    renderDashboard();
    if (updated && !warnIfSameDayConflict(updated)) showToast('Incarico aggiornato');
  }

  function initModal() {
    document.getElementById('modal-close-btn').addEventListener('click', closeEventModal);
    document.getElementById('event-modal').addEventListener('click', (e) => {
      if (e.target.id === 'event-modal') closeEventModal();
    });

    const reminderSelect = document.getElementById('modal-reminder-input');
    const customDaysInput = document.getElementById('modal-reminder-custom-days');
    reminderSelect.addEventListener('change', () => {
      customDaysInput.classList.toggle('hidden', reminderSelect.value !== 'custom');
    });

    document.getElementById('modal-save-btn').addEventListener('click', saveEventModal);

    document.getElementById('modal-delete-btn').addEventListener('click', () => {
      if (!editingEventId) return;
      if (confirm('Eliminare questo incarico?')) {
        Storage.deleteEvent(editingEventId);
        editingRevertFn = null; // eliminato volutamente: non riportarlo alla vecchia data
        document.getElementById('event-modal').classList.add('hidden');
        editingEventId = null;
        editingEventOriginal = null;
        renderCalendar();
        renderDashboard();
        showToast('Incarico eliminato');
      }
    });
  }

  // Click su un'anteprima PDF (generata dinamicamente) → la mostra ingrandita in un lightbox.
  function initSnippetLightbox() {
    const overlay = document.getElementById('image-lightbox');
    const img = document.getElementById('lightbox-img');
    document.addEventListener('click', (e) => {
      const snippet = e.target.closest('.pdf-snippet');
      if (snippet && snippet.src && !snippet.classList.contains('snippet-loading')) {
        img.src = snippet.src;
        overlay.classList.remove('hidden');
      }
    });
    document.getElementById('lightbox-close-btn').addEventListener('click', () => {
      overlay.classList.add('hidden');
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
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
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );
    if (files.length === 0) return;

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
  }

  async function extractPdfText(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('Libreria pdf.js non disponibile (controlla la connessione internet).');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

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

  const pageCanvasCache = new Map(); // "pdfUniqueId:pageNum" -> canvas renderizzato

  async function getRenderedPage(pdf, pageNum) {
    const cacheKey = (pdf.__trId || (pdf.__trId = uuid())) + ':' + pageNum;
    if (pageCanvasCache.has(cacheKey)) return pageCanvasCache.get(cacheKey);
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const result = { canvas, viewport };
    pageCanvasCache.set(cacheKey, result);
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

  function generateSnippetsAsync(pdf, pairs) {
    pairs.forEach(({ match, imgEl }) => {
      if (!imgEl || !match.snippetStrips || !match.snippetStrips.length) return;
      buildSnippetDataUrl(pdf, match.pageNum, match.snippetStrips)
        .then((dataUrl) => {
          imgEl.src = dataUrl;
          imgEl.classList.remove('snippet-loading');
        })
        .catch((err) => {
          console.error('Errore nella generazione dell\'anteprima PDF', err);
          const wrap = imgEl.closest('.pdf-snippet-wrap');
          if (wrap) wrap.classList.add('hidden');
        });
    });
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

  function parseShortDate(str) {
    const m = (str || '').trim().match(/^(\d{1,2})\/(\d{1,2})$/);
    if (!m) return '';
    const year = new Date().getFullYear();
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  // Altezza approssimativa di una riga di testo attorno alla sua baseline (in punti PDF),
  // usata per ritagliare le anteprime visive dal PDF.
  const ROW_ASCENT = 9;
  const ROW_DESCENT = 3;

  function tryExtractColumnAssignments(rawItems, pageNum) {
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
        guessedDate: parseShortDate(dateLabel),
        guessedTime: '',
        guessedRole: nearestHeader ? nearestHeader.label : 'Altro',
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
        let diff = (idx - today.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff);
        return isoDate(next);
      }
    }
    return '';
  }

  function guessDate(text) {
    if (!text) return '';
    const year = new Date().getFullYear();

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
    const columnResults = [];
    let usedColumnExtraction = false;

    pages.forEach(({ rawItems, pageNum }) => {
      const colMatches = tryExtractColumnAssignments(rawItems, pageNum);
      if (colMatches) {
        usedColumnExtraction = true;
        columnResults.push(...colMatches);
      }
    });
    if (usedColumnExtraction) return columnResults;

    const matches = [];
    pages.forEach(({ pageNum, lines, lineBoxes }) => {
      const pageText = lines.join(' | ');
      lines.forEach((line, idx) => {
        if (!isPianoLine(line)) return;
        const context = [lines[idx - 2], lines[idx - 1], line, lines[idx + 1], lines[idx + 2]]
          .filter(Boolean).join(' | ');
        const contextIdxs = [idx - 2, idx - 1, idx, idx + 1, idx + 2].filter((i) => i >= 0 && i < lineBoxes.length);
        matches.push({
          rawLine: line,
          context,
          // Prova prima sulla riga esatta del match (spesso contiene già la propria data), poi
          // allarga al contesto/pagina, infine ai giorni della settimana ricorrenti.
          // Il giorno della settimana va cercato prima sulla riga esatta del match: il contesto
          // allargato in documenti come "Orari Adunanze Servizio di Campo" elenca tutti i giorni
          // uno via l'altro, quindi potrebbe contenere un giorno diverso da quello giusto.
          guessedDate: guessDate(line) || guessWeekday(line) || guessDate(context) || guessWeekday(context) || guessDate(pageText),
          guessedTime: guessTime(line) || guessTime(context),
          guessedRole: guessRole(line, context, filename),
          pageNum,
          // Una sola fascia: il contesto (±2 righe) con la riga esatta del match evidenziata.
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

    return matches.map((match) => ({ match, imgEl: appendAssignmentCard(section, match, filename) }));
  }

  function appendAssignmentCard(container, match, sourcePdf) {
    const cardId = `assignment-${uploadCardCounter++}`;
    const hasSnippet = !!(match.snippetStrips && match.snippetStrips.length);

    const card = document.createElement('div');
    card.className = 'card assignment-card';
    card.innerHTML = `
      <p class="small-text" style="word-break:break-word;">${escapeHtml(match.rawLine)}</p>

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
      <input type="number" id="${cardId}-custom-days" placeholder="Giorni prima" class="hidden" style="margin-top:8px;" min="1">

      ${hasSnippet ? `
      <div class="pdf-snippet-wrap">
        <span class="pdf-snippet-label">📍 Dove è stato letto</span>
        <img class="pdf-snippet snippet-loading" id="${cardId}-snippet" alt="Punto del PDF da cui è stato estratto questo dato, con il testo evidenziato">
      </div>` : ''}

      <button class="btn-primary btn-block" style="margin-top:14px;" id="${cardId}-save">💾 Salva nel calendario</button>
    `;
    container.appendChild(card);

    const reminderSelect = card.querySelector(`#${cardId}-reminder`);
    const customDaysInput = card.querySelector(`#${cardId}-custom-days`);
    reminderSelect.addEventListener('change', () => {
      customDaysInput.classList.toggle('hidden', reminderSelect.value !== 'custom');
    });

    card.querySelector(`#${cardId}-save`).addEventListener('click', () => {
      const dateVal = card.querySelector(`#${cardId}-date`).value;
      if (!dateVal) {
        showToast('Inserisci una data valida prima di salvare');
        return;
      }
      const titleVal = card.querySelector(`#${cardId}-title`).value.trim() || 'Altro';
      const reminderType = reminderSelect.value;
      const evt = {
        id: uuid(),
        title: titleVal,
        date: dateVal,
        time: card.querySelector(`#${cardId}-time`).value || '',
        description: card.querySelector(`#${cardId}-desc`).value || '',
        sourcePdf: sourcePdf,
        reminder: {
          type: reminderType,
          customDays: reminderType === 'custom' ? (parseInt(customDaysInput.value, 10) || 0) : null
        },
        reminderFired: false,
        createdAt: new Date().toISOString()
      };
      Storage.addEvent(evt);
      scheduleReminderForEvent(evt);
      card.style.opacity = '0.5';
      card.querySelector(`#${cardId}-save`).textContent = '✅ Salvato';
      card.querySelector(`#${cardId}-save`).disabled = true;
      renderDashboard();
      if (!warnIfSameDayConflict(evt)) showToast('Incarico salvato nel calendario');
    });

    return hasSnippet ? card.querySelector(`#${cardId}-snippet`) : null;
  }

  /* ---------------------------------------------------------------------
     7. MOTORE PROMEMORIA / NOTIFICHE
     --------------------------------------------------------------------- */
  const reminderTimers = {}; // eventId -> timeoutId
  const REMINDER_DAYS = { '3days': 3, '1day': 1 };
  const MISSED_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h: recupera promemoria mancati entro questa finestra

  function getReminderOffsetMs(reminder) {
    if (!reminder || reminder.type === 'none') return null;
    const days = reminder.type === 'custom' ? (reminder.customDays || 0) : REMINDER_DAYS[reminder.type];
    if (!days) return null;
    return days * 24 * 60 * 60 * 1000;
  }

  function scheduleReminderForEvent(evt) {
    if (evt.reminderFired) return;
    const offset = getReminderOffsetMs(evt.reminder);
    if (offset === null) return;

    const eventTime = new Date(evt.date + 'T' + (evt.time || '00:00')).getTime();
    const fireTime = eventTime - offset;
    const now = Date.now();
    const delay = fireTime - now;

    if (delay < 0) {
      // Promemoria nel passato: se rientra nella finestra "mancati", mostralo subito.
      if (delay > -MISSED_WINDOW_MS) {
        fireReminder(evt);
      }
      return;
    }

    // setTimeout ha un limite massimo (~24.8 giorni); per delay molto lunghi usiamo il loop di controllo periodico.
    if (delay < 24 * 60 * 60 * 1000) {
      clearTimeout(reminderTimers[evt.id]);
      reminderTimers[evt.id] = setTimeout(() => fireReminder(evt), delay);
    }
  }

  function fireReminder(evt) {
    const current = Storage.getEvents().find((e) => e.id === evt.id);
    if (!current || current.reminderFired) return;

    const title = 'Promemoria incarico';
    const body = `${current.title} — ${formatDateIt(current.date, current.time)}`;

    showNotification(title, body);
    Storage.updateEvent(current.id, { reminderFired: true });
  }

  function showNotification(title, body) {
    if (Notification.permission !== 'granted') return;
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg && reg.showNotification) {
          reg.showNotification(title, { body, icon: './icons/icon-192.png', badge: './icons/icon-192.png' });
        } else {
          new Notification(title, { body, icon: './icons/icon-192.png' });
        }
      }).catch(() => {
        new Notification(title, { body, icon: './icons/icon-192.png' });
      });
    } else {
      new Notification(title, { body, icon: './icons/icon-192.png' });
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
        if (evt.reminderFired) return;
        const offset = getReminderOffsetMs(evt.reminder);
        if (offset === null) return;
        const eventTime = new Date(evt.date + 'T' + (evt.time || '00:00')).getTime();
        const fireTime = eventTime - offset;
        if (now >= fireTime && now - fireTime < MISSED_WINDOW_MS) {
          fireReminder(evt);
        }
      });
    }, 25000);
  }

  function initNotifications() {
    const btn = document.getElementById('enable-notifications-btn');
    const statusEl = document.getElementById('notification-status');

    function updateStatus() {
      const settings = Storage.getSettings();
      if (!('Notification' in window)) {
        statusEl.textContent = 'Le notifiche non sono supportate su questo browser.';
        btn.disabled = true;
        return;
      }
      if (Notification.permission === 'granted' && settings.notificationsEnabled) {
        statusEl.textContent = '✅ Notifiche attive.';
        btn.textContent = '🔔 Notifiche attive';
      } else if (Notification.permission === 'denied') {
        statusEl.textContent = '❌ Notifiche bloccate dal browser. Abilitale nelle impostazioni del sito.';
      } else {
        statusEl.textContent = 'Notifiche non ancora attivate.';
        btn.textContent = '🔔 Attiva notifiche';
      }
    }

    btn.addEventListener('click', async () => {
      if (!('Notification' in window)) return;
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        Storage.updateSettings({ notificationsEnabled: true });
        recalcAllReminders();
        showToast('Notifiche attivate');
      } else {
        showToast('Permesso notifiche non concesso');
      }
      updateStatus();
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

  function csvEscape(val) {
    const s = String(val == null ? '' : val);
    if (/[;"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
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
    const lines = [header, ...rows].map((cols) => cols.map(csvEscape).join(';'));
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

  function initClearData() {
    document.getElementById('clear-data-btn').addEventListener('click', () => {
      if (confirm('Cancellare TUTTI gli incarichi salvati? Questa azione non è reversibile.')) {
        Storage.saveEvents([]);
        renderDashboard();
        renderCalendar();
        renderStats();
        showToast('Dati cancellati');
      }
    });
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
      (e) => new Date(e.date).getFullYear() === currentYear
    ).length;

    const byMonth = {};
    events.forEach((e) => {
      const d = new Date(e.date);
      if (isNaN(d)) return;
      const label = `${MONTHS_IT[d.getMonth()]} ${d.getFullYear()}`;
      byMonth[label] = (byMonth[label] || 0) + 1;
    });
    renderBarChart('stats-by-month', byMonth);

    const byRole = {};
    events.forEach((e) => { byRole[e.title] = (byRole[e.title] || 0) + 1; });
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
    }
  }

  function init() {
    initNavigation();
    initModal();
    initSnippetLightbox();
    initPdfUpload();
    initNotifications();
    initClearData();
    registerServiceWorker();

    document.getElementById('export-csv-btn').addEventListener('click', exportCsv);

    renderDashboard();
    recalcAllReminders();
    startReminderPollingLoop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
