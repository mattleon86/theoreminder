'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const core = require('../shared/core');

const clone = (value) => value == null ? null : JSON.parse(JSON.stringify(value));

class FakeKv {
  constructor() {
    this.data = new Map();
    this.evalCalls = [];
  }

  async get(key) {
    return clone(this.data.has(key) ? this.data.get(key) : null);
  }

  async set(key, value, options) {
    if (options && options.nx && this.data.has(key)) return null;
    this.data.set(key, clone(value));
    return 'OK';
  }

  async del(key) {
    return this.data.delete(key) ? 1 : 0;
  }

  async eval(script, keys, args) {
    this.evalCalls.push(script);
    const key = keys[0];
    if (script === store.SCRIPTS.MERGE_STATE_SCRIPT) {
      const current = this.data.has(key) ? store.fromStoredState(this.data.get(key)) : store.fromStoredState(JSON.parse(args[1]));
      const merged = core.mergeStates(current, JSON.parse(args[0]));
      this.data.set(key, store.toStoredState(merged));
      return 'OK';
    }
    if (script === store.SCRIPTS.MARK_FIRED_SCRIPT) {
      const source = this.data.has(key) ? this.data.get(key) : JSON.parse(args[2]);
      const state = store.fromStoredState(source);
      const byId = new Map(state.events.map((evt) => [evt.id, evt]));
      let marked = 0;
      for (const expected of JSON.parse(args[0])) {
        const evt = byId.get(expected.id);
        if (!evt || evt.reminderFired || evt.date !== expected.date || (evt.time || '') !== (expected.time || '') ||
            core.stableStringify(evt.reminder) !== core.stableStringify(expected.reminder)) continue;
        evt.reminderFired = true;
        evt.reminderFiredAt = args[1];
        if (!core.isValidIso(evt.updatedAt) || Date.parse(evt.updatedAt) < Date.parse(args[1])) evt.updatedAt = args[1];
        marked += 1;
      }
      if (marked) this.data.set(key, store.toStoredState(state));
      return marked;
    }
    if (script === store.SCRIPTS.ADD_SUBSCRIPTION_SCRIPT) {
      const raw = this.data.get(key);
      const values = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
      const map = Object.fromEntries(values.filter((sub) => sub && sub.endpoint).map((sub) => [sub.endpoint, sub]));
      const incoming = JSON.parse(args[0]);
      map[incoming.endpoint] = incoming;
      this.data.set(key, map);
      return 1;
    }
    if (script === store.SCRIPTS.REMOVE_SUBSCRIPTIONS_SCRIPT) {
      const raw = this.data.get(key);
      const values = Array.isArray(raw) ? raw : raw ? Object.values(raw) : [];
      const map = Object.fromEntries(values.filter((sub) => sub && sub.endpoint).map((sub) => [sub.endpoint, sub]));
      let removed = 0;
      for (const endpoint of JSON.parse(args[0])) {
        if (map[endpoint]) {
          delete map[endpoint];
          removed += 1;
        }
      }
      this.data.set(key, map);
      return removed;
    }
    if (script === store.SCRIPTS.RECORD_BACKUP_SCRIPT) {
      const labels = [...new Set((this.data.get(key) || []).concat(args[0]))].sort();
      while (labels.length > Number(args[1])) this.data.delete(args[2] + labels.shift());
      this.data.set(key, labels);
      return labels.length;
    }
    throw new Error('Script KV non riconosciuto');
  }
}

const kv = new FakeKv();
const kvModule = require.resolve('@vercel/kv');
require.cache[kvModule] = { id: kvModule, filename: kvModule, loaded: true, exports: { kv } };
const store = require('../lib/store');
const eventsHandler = require('../api/events');
const pushHandler = require('../api/push-subscribe');
const backupsHandler = require('../api/list-backups');
const remindersHandler = require('../api/send-reminders');

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(method, body, options = {}) {
  const headers = {};
  if (options.key !== null) headers['x-sync-key'] = options.key || 'test-secret';
  if (options.authorization) headers.authorization = options.authorization;
  return { method, body, headers, socket: { remoteAddress: options.ip || '127.0.0.1' } };
}

function patchMethod(t, object, name, replacement) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  Object.defineProperty(object, name, { configurable: true, writable: true, value: replacement });
  t.after(() => {
    if (descriptor) Object.defineProperty(object, name, descriptor);
    else delete object[name];
  });
}

function useFakeKv(_t, fake) {
  kv.data = fake.data;
  kv.evalCalls = fake.evalCalls;
}

function setEnv(t, values) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function event(id, patch = {}) {
  return {
    id, title: 'Discorso', date: '2026-11-21', time: '09:00', description: '',
    sourcePdf: null, reminder: { type: '1day', customDays: null }, reminderFired: false,
    createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:00:00.000Z', ...patch
  };
}

function subscription(name, key = 'A') {
  return { endpoint: `https://push.example/${name}`, keys: { p256dh: key.repeat(43), auth: key.repeat(22) } };
}

function seedState(fake, events, deleted = {}, clearedAt = '') {
  fake.data.set(store.STATE_KEY, store.toStoredState({ events, deleted, clearedAt }));
}

test('lo stato legge e normalizza le chiavi legacy senza resuscitare eliminati', async () => {
  const fake = new FakeKv();
  fake.data.set(store.LEGACY_EVENTS_KEY, [event('a'), event('b'), null, event('bad', { date: '2026-02-31' })]);
  fake.data.set(store.LEGACY_DELETED_KEY, { b: '2026-11-20T12:00:00.000Z', invalid: 'no' });
  const state = await store.getState(fake);
  assert.deepEqual(state.events.map((evt) => evt.id), ['a']);
  assert.deepEqual(state.deleted, { b: '2026-11-20T12:00:00.000Z' });
});

test('la validazione rifiuta eventi nulli, duplicati e metadati non validi', () => {
  assert.throws(() => store.normalizeIncomingState({ events: [null] }), TypeError);
  assert.throws(() => store.normalizeIncomingState({ events: [event('a'), event('a')] }), TypeError);
  assert.throws(() => store.normalizeIncomingState({ events: [event('a', { time: 0 })] }), TypeError);
  assert.throws(() => store.normalizeIncomingState({ events: [], deleted: [] }), TypeError);
  assert.throws(() => store.normalizeIncomingState({ events: [], deleted: { a: 'ieri' } }), TypeError);
  assert.throws(() => store.normalizeIncomingState({ events: [], clearedAt: '2026-13-01T00:00:00.000Z' }), TypeError);
  assert.equal(store.normalizeIncomingState({ events: { a: event('a') } }).events.length, 1);
});

test('PUT concurrenti conservano eventi distinti e lo stato interno usa una mappa', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret' });
  seedState(fake, [event('existing')]);
  const first = response();
  const second = response();
  await Promise.all([
    eventsHandler(request('PUT', { events: [event('a')] }), first),
    eventsHandler(request('PUT', { events: [event('b')] }, { ip: '127.0.0.2' }), second)
  ]);
  const responses = [first, second];
  assert.deepEqual(responses.map((res) => res.statusCode), [200, 200]);
  assert.equal(responses[0].headers['cache-control'], 'private, no-store');
  assert.equal(responses[0].body.ok, true);
  assert.ok(Array.isArray(responses[0].body.events));
  const state = await store.getState();
  assert.deepEqual(state.events.map((evt) => evt.id).sort(), ['a', 'b', 'existing']);
  const stored = fake.data.get(store.STATE_KEY);
  assert.equal(Array.isArray(stored.events), false);
  assert.equal(stored.events.a.id, 'a');
});

test('PUT malformato restituisce 400 senza scrivere', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret' });
  const res = response();
  await eventsHandler(request('PUT', { events: [null] }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(fake.evalCalls.length, 0);
  assert.equal(fake.data.size, 0);
});

test('merge dello stato unisce tombstone senza scadenza e rispetta clearedAt', async () => {
  const fake = new FakeKv();
  seedState(fake, [event('a'), event('old')]);
  await store.mergeState({ events: [event('b', { updatedAt: '2026-11-20T13:00:00.000Z' })], deleted: { a: '2026-11-20T11:00:00.000Z' } }, fake);
  await store.mergeState({ events: [event('a', { updatedAt: '2026-11-20T10:30:00.000Z' })], deleted: {}, clearedAt: '2026-11-20T12:00:00.000Z' }, fake);
  const state = await store.getState(fake);
  assert.deepEqual(state.events.map((evt) => evt.id), ['b']);
  assert.equal(state.deleted.a, '2026-11-20T11:00:00.000Z');
  assert.equal(state.clearedAt, '2026-11-20T12:00:00.000Z');
});

test('mark-fired aggiorna solo la pianificazione inviata senza ripristinare snapshot vecchi', async () => {
  const fake = new FakeKv();
  seedState(fake, [event('a')]);
  const current = fake.data.get(store.STATE_KEY);
  current.events.a.title = 'Titolo modificato durante il push';
  current.events.a.updatedAt = '2026-11-20T12:00:00.000Z';
  const marked = await store.markRemindersFired([
    { id: 'a', date: '2026-11-21', time: '09:00', reminder: { type: '1day', customDays: null } }
  ], '2026-11-20T11:00:00.000Z', fake);
  const state = await store.getState(fake);
  assert.equal(marked, 1);
  assert.equal(state.events[0].title, 'Titolo modificato durante il push');
  assert.equal(state.events[0].updatedAt, '2026-11-20T12:00:00.000Z');
  assert.equal(state.events[0].reminderFired, true);
  assert.equal(state.events[0].reminderFiredAt, '2026-11-20T11:00:00.000Z');
});

test('mark-fired ignora eventi mancanti, già inviati o con data/ora/promemoria cambiato', async () => {
  const fake = new FakeKv();
  const reminder = { type: '1day', customDays: null };
  seedState(fake, [
    event('date', { date: '2026-11-22' }),
    event('time', { time: '10:00' }),
    event('reminder', { reminder: { type: '3days', customDays: null } }),
    event('fired', { reminderFired: true })
  ]);
  const expected = ['date', 'time', 'reminder', 'fired', 'missing'].map((id) => ({ id, date: '2026-11-21', time: '09:00', reminder }));
  assert.equal(await store.markRemindersFired(expected, '2026-11-20T08:00:00.000Z', fake), 0);
  const state = await store.getState(fake);
  assert.equal(state.events.some((evt) => evt.reminderFiredAt), false);
});

test('sottoscrizioni concurrenti deduplicano per endpoint e migrano la lista legacy', async () => {
  const fake = new FakeKv();
  const legacy = subscription('legacy', 'L');
  fake.data.set(store.SUBS_KEY, [legacy]);
  const first = subscription('a', 'A');
  const replacement = subscription('a', 'B');
  await Promise.all([
    store.addSubscription(first, fake),
    store.addSubscription(subscription('b', 'C'), fake),
    store.addSubscription(replacement, fake)
  ]);
  const subscriptions = await store.listSubscriptions(fake);
  assert.equal(subscriptions.length, 3);
  assert.equal(subscriptions.find((sub) => sub.endpoint === first.endpoint).keys.p256dh, replacement.keys.p256dh);
  assert.equal(Array.isArray(fake.data.get(store.SUBS_KEY)), false);
  assert.equal(await store.removeSubscriptions([first.endpoint], fake), 1);
  assert.deepEqual((await store.listSubscriptions(fake)).map((sub) => new URL(sub.endpoint).pathname).sort(), ['/b', '/legacy']);
});

test('backup mensile usa NX e conserva 12 snapshot', async () => {
  const fake = new FakeKv();
  const label = store.monthlyBackupLabel(new Date('2026-11-24T12:00:00.000Z'));
  const first = await store.createBackup({ events: [event('a')] }, label, 'cron', fake);
  const second = await store.createBackup({ events: [event('a'), event('b')] }, label, 'cron', fake);
  assert.equal(label, '2026-11');
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.backup.events.length, 1);
  assert.deepEqual(await store.backupLabels(fake), [label]);

  for (let month = 1; month <= 12; month += 1) {
    await store.createBackup({ events: [] }, `2025-${String(month).padStart(2, '0')}`, 'cron', fake);
  }
  await store.createBackup({ events: [] }, '2026-01', 'cron', fake);
  const labels = await store.backupLabels(fake);
  assert.equal(labels.length, 12);
  assert.equal(labels.includes('2025-01'), false);
  assert.equal(fake.data.has(`${store.BACKUP_PREFIX}2025-01`), false);
});

test('etichette backup accettate solo nel formato mensile o manuale', () => {
  assert.equal(store.isValidBackupLabel('2026-11'), true);
  assert.equal(store.isValidBackupLabel('manual-20261124-123456'), true);
  assert.equal(store.isValidBackupLabel('manual-20260231-123456'), false);
  assert.equal(store.isValidBackupLabel('../segreto'), false);
  assert.equal(store.manualBackupLabel(new Date('2026-11-24T12:34:56.000Z')), 'manual-20261124-123456');
});

test('autenticazione sync usa no-store e limita i tentativi falliti', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret' });
  const ip = '198.51.100.10';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = response();
    await eventsHandler(request('GET', null, { key: 'wrong', ip }), res);
    assert.equal(res.statusCode, 401);
  }
  const limited = response();
  await eventsHandler(request('GET', null, { ip }), limited);
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  const allowed = response();
  await eventsHandler(request('GET', null, { ip: '198.51.100.11' }), allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['cache-control'], 'private, no-store');
});

test('API push valida endpoint e chiavi prima della scrittura atomica', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret' });
  const invalid = response();
  await pushHandler(request('POST', { subscription: { endpoint: 'http://push.example/a', keys: {} } }), invalid);
  assert.equal(invalid.statusCode, 400);
  const missingKeys = response();
  await pushHandler(request('POST', { subscription: { endpoint: 'https://push.example/a' } }), missingKeys);
  assert.equal(missingKeys.statusCode, 400);
  const valid = response();
  await pushHandler(request('POST', { subscription: subscription('a') }), valid);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.headers['cache-control'], 'private, no-store');
  assert.equal((await store.listSubscriptions()).length, 1);
  const removed = response();
  await pushHandler(request('DELETE', { endpoint: 'https://push.example/a' }), removed);
  assert.equal(removed.statusCode, 200);
  assert.equal((await store.listSubscriptions()).length, 0);
});

test('API backup crea e recupera un manuale dallo stato autorevole', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret' });
  fake.data.set(store.LEGACY_EVENTS_KEY, [event('legacy')]);
  seedState(fake, [event('authoritative')], { removed: '2026-11-20T10:00:00.000Z' }, '2026-11-18T11:00:00.000Z');
  const created = response();
  await backupsHandler(request('POST', {}), created);
  assert.equal(created.statusCode, 200);
  assert.match(created.body.label, /^manual-\d{8}-\d{6}$/);
  assert.equal(created.body.lastBackup.eventCount, 1);
  const detail = response();
  await backupsHandler(request('GET', null, { query: undefined }), detail);
  assert.equal(detail.statusCode, 200);
  const withQuery = { ...request('GET', null), query: { label: created.body.label } };
  const backup = response();
  await backupsHandler(withQuery, backup);
  assert.equal(backup.statusCode, 200);
  assert.equal(backup.body.events[0].id, 'authoritative');
  assert.equal(backup.body.deleted.removed, '2026-11-20T10:00:00.000Z');
  assert.equal(backup.body.clearedAt, '2026-11-18T11:00:00.000Z');
  const invalid = response();
  await backupsHandler({ ...request('GET', null), query: { label: '../segreto' } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test('un push fallito non marca il promemoria come inviato', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret', CRON_SECRET: 'cron-secret', VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' });
  patchMethod(t, Date, 'now', () => Date.parse('2026-11-20T08:00:00.000Z'));
  patchMethod(t, webpush, 'setVapidDetails', () => {});
  patchMethod(t, webpush, 'sendNotification', async () => { throw Object.assign(new Error('dettaglio privato'), { statusCode: 500 }); });
  patchMethod(t, console, 'warn', () => {});
  patchMethod(t, console, 'error', () => {});
  seedState(fake, [event('due')]);
  fake.data.set(store.SUBS_KEY, { [subscription('a').endpoint]: subscription('a') });
  const res = response();
  await remindersHandler(request('POST', null, { key: null, authorization: 'Bearer cron-secret' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.events, 1);
  assert.equal(res.body.deliveries, 0);
  assert.equal(res.body.marked, 0);
  assert.equal((await store.getState()).events[0].reminderFired, false);
});

test('almeno una consegna marca il promemoria e rimuove atomicamente gli endpoint morti', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret', CRON_SECRET: 'cron-secret', VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' });
  patchMethod(t, Date, 'now', () => Date.parse('2026-11-20T08:00:00.000Z'));
  patchMethod(t, webpush, 'setVapidDetails', () => {});
  const payloads = [];
  patchMethod(t, webpush, 'sendNotification', async (sub, payload) => {
    payloads.push(JSON.parse(payload));
    if (sub.endpoint.includes('/dead')) throw Object.assign(new Error('endpoint privato'), { statusCode: 410 });
  });
  patchMethod(t, console, 'warn', () => {});
  patchMethod(t, console, 'error', () => {});
  seedState(fake, [event('due')]);
  const dead = subscription('dead');
  const live = subscription('live');
  fake.data.set(store.SUBS_KEY, { [dead.endpoint]: dead, [live.endpoint]: live });
  const res = response();
  await remindersHandler(request('POST', null, { key: null, authorization: 'Bearer cron-secret' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deliveries, 1);
  assert.equal(res.body.marked, 1);
  assert.equal(res.body.removedSubscriptions, 1);
  assert.equal(payloads[0].eventId, 'due');
  assert.equal(payloads[0].date, '2026-11-21');
  assert.equal((await store.getState()).events[0].reminderFired, true);
  assert.deepEqual((await store.listSubscriptions()).map((sub) => sub.endpoint), [live.endpoint]);
});

test('il backup mensile viene creato anche senza VAPID e non sovrascritto', async (t) => {
  const fake = new FakeKv();
  useFakeKv(t, fake);
  setEnv(t, { SYNC_SECRET: 'test-secret', CRON_SECRET: 'cron-secret', VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined });
  patchMethod(t, console, 'error', () => {});
  seedState(fake, [event('future', { date: '2027-01-01' })]);
  const first = response();
  await remindersHandler(request('POST', null, { key: null, authorization: 'Bearer cron-secret' }), first);
  const second = response();
  await remindersHandler(request('POST', null, { key: null, authorization: 'Bearer cron-secret' }), second);
  assert.equal(first.statusCode, 500);
  assert.equal(second.statusCode, 500);
  assert.equal(first.body.backup.created, true);
  assert.equal(second.body.backup.created, false);
  const labels = await store.backupLabels();
  assert.equal(labels.length, 1);
  assert.equal((await store.getBackup(labels[0])).events[0].id, 'future');
});
