/* TheoReminder — funzioni pure condivise tra browser, API e test. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TheoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_TIME_ZONE = 'Europe/Rome';
  const REMINDER_DAYS = { '3days': 3, '1day': 1 };
  const REMINDER_TYPES = new Set(['none', '3days', '1day', 'custom']);

  function isValidIso(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
  }

  function isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  function isValidTime(value) {
    return value === '' || (typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value));
  }

  function validReminder(reminder) {
    if (!reminder || typeof reminder !== 'object' || !REMINDER_TYPES.has(reminder.type)) return false;
    if (reminder.type === 'custom') return Number.isInteger(reminder.customDays) && reminder.customDays >= 0 && reminder.customDays <= 3650;
    return reminder.customDays == null || reminder.customDays === '';
  }

  function validateEvent(evt) {
    if (!evt || typeof evt !== 'object' || Array.isArray(evt)) return false;
    if (typeof evt.id !== 'string' || !evt.id || evt.id.length > 128) return false;
    if (typeof evt.title !== 'string' || !evt.title.trim() || evt.title.length > 300) return false;
    if (!isValidDate(evt.date) || !isValidTime(evt.time || '')) return false;
    if (evt.description != null && (typeof evt.description !== 'string' || evt.description.length > 5000)) return false;
    if (evt.sourcePdf != null && (typeof evt.sourcePdf !== 'string' || evt.sourcePdf.length > 500)) return false;
    if (!validReminder(evt.reminder)) return false;
    if (evt.reminderFired != null && typeof evt.reminderFired !== 'boolean') return false;
    if (evt.reminderFiredAt != null && evt.reminderFiredAt !== '' && !isValidIso(evt.reminderFiredAt)) return false;
    if (evt.updatedAt != null && !isValidIso(evt.updatedAt)) return false;
    if (evt.createdAt != null && !isValidIso(evt.createdAt)) return false;
    return true;
  }

  function normalizeState(input) {
    const source = input && typeof input === 'object' ? input : {};
    const list = Array.isArray(source.events) ? source.events : Object.values(source.events || {});
    const events = [];
    const seen = new Set();
    list.forEach((evt) => {
      if (!validateEvent(evt) || seen.has(evt.id)) return;
      const normalized = Object.assign({}, evt, { reminder: Object.assign({}, evt.reminder) });
      // Vecchie versioni potevano salvare "personalizzato" con 0 giorni: equivale a nessun promemoria.
      if (normalized.reminder.type === 'custom' && normalized.reminder.customDays === 0) {
        normalized.reminder = { type: 'none', customDays: null };
      }
      seen.add(normalized.id);
      events.push(normalized);
    });
    const deleted = {};
    if (source.deleted && typeof source.deleted === 'object' && !Array.isArray(source.deleted)) {
      Object.entries(source.deleted).forEach(([id, value]) => {
        if (id && isValidIso(value)) deleted[id] = value;
      });
    }
    return { events, deleted, clearedAt: isValidIso(source.clearedAt) ? source.clearedAt : '' };
  }

  function eventStamp(evt) {
    const value = Date.parse((evt && evt.updatedAt) || '');
    return Number.isFinite(value) ? value : 0;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function mergeStates(left, right) {
    const a = normalizeState(left);
    const b = normalizeState(right);
    const deleted = Object.assign({}, a.deleted);
    Object.entries(b.deleted).forEach(([id, value]) => {
      if (!deleted[id] || Date.parse(value) > Date.parse(deleted[id])) deleted[id] = value;
    });
    const clearedAt = !a.clearedAt ? b.clearedAt : !b.clearedAt ? a.clearedAt : (Date.parse(a.clearedAt) >= Date.parse(b.clearedAt) ? a.clearedAt : b.clearedAt);
    const winners = new Map();
    a.events.concat(b.events).forEach((evt) => {
      const current = winners.get(evt.id);
      if (!current || eventStamp(evt) > eventStamp(current) ||
          (eventStamp(evt) === eventStamp(current) && stableStringify(evt) > stableStringify(current))) {
        winners.set(evt.id, evt);
      }
    });
    const events = [];
    winners.forEach((evt, id) => {
      const tomb = Date.parse(deleted[id] || '');
      const clear = Date.parse(clearedAt || '');
      if (Number.isFinite(tomb) && tomb >= eventStamp(evt)) return;
      if (Number.isFinite(clear) && clear >= eventStamp(evt)) return;
      events.push(evt);
    });
    events.sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || '') || x.id.localeCompare(y.id));
    return { events, deleted, clearedAt };
  }

  function sameEventList(a, b) {
    const left = normalizeState({ events: a }).events;
    const right = normalizeState({ events: b }).events;
    if (left.length !== right.length) return false;
    const byId = (list) => Object.fromEntries(list.map((evt) => [evt.id, stableStringify(evt)]));
    const ma = byId(left);
    const mb = byId(right);
    return Object.keys(ma).length === Object.keys(mb).length && Object.keys(ma).every((id) => ma[id] === mb[id]);
  }

  function sameDeletedMap(a, b) {
    return stableStringify(a || {}) === stableStringify(b || {});
  }

  function getReminderDays(reminder) {
    if (!reminder || reminder.type === 'none') return null;
    const days = reminder.type === 'custom' ? reminder.customDays : REMINDER_DAYS[reminder.type];
    return Number.isInteger(days) && days >= 1 ? days : null;
  }

  function getReminderOffsetMs(reminder) {
    const days = getReminderDays(reminder);
    return days == null ? null : days * DAY_MS;
  }

  function getZonedParts(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const out = {};
    parts.forEach((part) => { if (part.type !== 'literal') out[part.type] = Number(part.value); });
    return out;
  }

  function zonedLocalToUtc(dateStr, timeStr, timeZone) {
    if (!isValidDate(dateStr) || !isValidTime(timeStr || '')) return NaN;
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hour, minute] = (timeStr || '00:00').split(':').map(Number);
    const wanted = Date.UTC(y, m - 1, d, hour, minute);
    let timestamp = wanted;
    for (let i = 0; i < 3; i++) {
      const p = getZonedParts(timestamp, timeZone || DEFAULT_TIME_ZONE);
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      timestamp += wanted - represented;
    }
    return timestamp;
  }

  function reminderFireTime(evt, timeZone) {
    const days = getReminderDays(evt && evt.reminder);
    if (days == null || !evt || !isValidDate(evt.date)) return NaN;
    const zone = timeZone || DEFAULT_TIME_ZONE;
    const eventUtc = zonedLocalToUtc(evt.date, evt.time || '', zone);
    if (!Number.isFinite(eventUtc)) return NaN;
    const p = getZonedParts(eventUtc, zone);
    const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day - days, p.hour, p.minute));
    const date = shifted.toISOString().slice(0, 10);
    return zonedLocalToUtc(date, evt.time || '', zone);
  }

  function isReminderDue(evt, now, missedWindowMs, timeZone) {
    if (!evt || evt.reminderFired) return false;
    const firedAt = Date.parse(evt.reminderFiredAt || '');
    if (Number.isFinite(firedAt) && now - firedAt < missedWindowMs) return false;
    const fireTime = reminderFireTime(evt, timeZone);
    return Number.isFinite(fireTime) && now >= fireTime && now - fireTime < missedWindowMs;
  }

  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return /[;"\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function guessYearFromFilename(filename) {
    const match = String(filename || '').match(/\b(20\d{2})\b/);
    return match ? Number(match[1]) : new Date().getFullYear();
  }

  function makeBackup(state, source) {
    return {
      app: 'TheoReminder', version: 2, exportedAt: new Date().toISOString(),
      source: source || 'manual', ...normalizeState(state)
    };
  }

  return {
    DAY_MS, DEFAULT_TIME_ZONE, REMINDER_DAYS,
    isValidIso, isValidDate, isValidTime, validReminder, validateEvent,
    normalizeState, eventStamp, stableStringify, mergeStates,
    sameEventList, sameDeletedMap, getReminderDays, getReminderOffsetMs,
    getZonedParts, zonedLocalToUtc, reminderFireTime, isReminderDue,
    csvCell, guessYearFromFilename, makeBackup
  };
});
