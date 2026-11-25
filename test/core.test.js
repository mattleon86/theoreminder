const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core');

const event = (id, updatedAt, patch = {}) => ({
  id, title: 'Discorso', date: '2026-11-20', time: '18:30', description: '',
  sourcePdf: null, reminder: { type: '1day', customDays: null },
  reminderFired: false, createdAt: updatedAt, updatedAt, ...patch
});

test('merge conserva eventi distinti creati da due dispositivi', () => {
  const a = { events: [event('a', '2026-11-20T10:00:00.000Z')], deleted: {}, clearedAt: '' };
  const b = { events: [event('b', '2026-11-20T10:01:00.000Z')], deleted: {}, clearedAt: '' };
  const merged = core.mergeStates(a, b);
  assert.deepEqual(merged.events.map((e) => e.id).sort(), ['a', 'b']);
});

test('merge sceglie la modifica più recente e rispetta i tombstone', () => {
  const a = { events: [event('a', '2026-11-20T10:00:00.000Z', { title: 'Vecchio' })], deleted: {}, clearedAt: '' };
  const b = { events: [event('a', '2026-11-20T11:00:00.000Z', { title: 'Nuovo' })], deleted: {}, clearedAt: '' };
  assert.equal(core.mergeStates(a, b).events[0].title, 'Nuovo');
  const removed = core.mergeStates(b, { events: [], deleted: { a: '2026-11-20T12:00:00.000Z' }, clearedAt: '' });
  assert.equal(removed.events.length, 0);
});

test('cancellazione globale elimina anche eventi non conosciuti dal dispositivo che cancella', () => {
  const offline = { events: [event('offline', '2026-11-20T10:00:00.000Z')], deleted: {}, clearedAt: '' };
  const clear = { events: [], deleted: {}, clearedAt: '2026-11-20T12:00:00.000Z' };
  assert.equal(core.mergeStates(offline, clear).events.length, 0);
  const newer = { events: [event('new', '2026-11-20T13:00:00.000Z')], deleted: {}, clearedAt: '' };
  assert.equal(core.mergeStates(newer, clear).events.length, 1);
});

test('validazione rifiuta date e promemoria personalizzati invalidi', () => {
  assert.equal(core.validateEvent(event('ok', '2026-11-20T10:00:00.000Z')), true);
  assert.equal(core.validateEvent(event('bad-date', '2026-11-20T10:00:00.000Z', { date: '2026-02-31' })), false);
  assert.equal(core.validateEvent(event('bad-reminder', '2026-11-20T10:00:00.000Z', { reminder: { type: 'custom', customDays: -1 } })), false);
  const legacy = core.normalizeState({ events: [event('legacy', '2026-11-20T10:00:00.000Z', { reminder: { type: 'custom', customDays: 0 } })] });
  assert.equal(legacy.events[0].reminder.type, 'none');
});

test('promemoria usa Europe/Rome anche durante il cambio ora', () => {
  const evt = event('dst', '2026-10-20T10:00:00.000Z', { date: '2026-10-26', time: '09:00', reminder: { type: '1day', customDays: null } });
  assert.equal(new Date(core.reminderFireTime(evt)).toISOString(), '2026-10-25T08:00:00.000Z');
});

test('CSV neutralizza le formule Excel', () => {
  assert.equal(core.csvCell('=1+1'), "'=1+1");
  assert.equal(core.csvCell('testo'), 'testo');
  assert.equal(core.csvCell('a;b'), '"a;b"');
});

test('confronto stati indipendente dall ordine e dalle proprietà', () => {
  const a = [event('a', '2026-11-20T10:00:00.000Z'), event('b', '2026-11-21T10:00:00.000Z')];
  const b = [Object.assign({}, a[1]), Object.assign({}, a[0])];
  assert.equal(core.sameEventList(a, b), true);
});
