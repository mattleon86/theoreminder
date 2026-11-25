'use strict';

const { kv } = require('@vercel/kv');
const core = require('../shared/core');

const STATE_KEY = 'theoreminder:state';
const LEGACY_EVENTS_KEY = 'theoreminder:events';
const LEGACY_DELETED_KEY = 'theoreminder:deleted';
const SUBS_KEY = 'theoreminder:push-subscriptions';
const BACKUP_PREFIX = 'theoreminder:events-backup:';
const BACKUP_INDEX_KEY = 'theoreminder:events-backup-index';
const KEEP_BACKUPS = 12;
const UNSAFE_IDS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStoredState(state) {
  const normalized = core.normalizeState(state);
  return {
    events: Object.fromEntries(normalized.events.map((evt) => [evt.id, evt])),
    deleted: normalized.deleted,
    clearedAt: normalized.clearedAt
  };
}

function fromStoredState(value) {
  return core.mergeStates({}, isRecord(value) ? value : {});
}

function normalizeIncomingState(body) {
  if (!isRecord(body)) throw new TypeError('Corpo della richiesta non valido');
  const events = Array.isArray(body.events) ? body.events : isRecord(body.events) ? Object.values(body.events) : null;
  if (!events) throw new TypeError('Atteso un elenco di eventi valido');

  const seen = new Set();
  for (const evt of events) {
    if (!core.validateEvent(evt) || (evt.time != null && typeof evt.time !== 'string') || UNSAFE_IDS.has(evt.id)) {
      throw new TypeError('Uno o più eventi non sono validi');
    }
    if (seen.has(evt.id)) throw new TypeError('ID evento duplicato');
    seen.add(evt.id);
  }

  if (body.deleted !== undefined && !isRecord(body.deleted)) throw new TypeError('Mappa delle eliminazioni non valida');
  for (const [id, value] of Object.entries(body.deleted || {})) {
    if (!id || id.length > 128 || UNSAFE_IDS.has(id) || !core.isValidIso(value)) {
      throw new TypeError('Eliminazione non valida');
    }
  }
  if (body.clearedAt !== undefined && body.clearedAt !== '' && !core.isValidIso(body.clearedAt)) {
    throw new TypeError('Data di cancellazione globale non valida');
  }

  return core.normalizeState({ events, deleted: body.deleted || {}, clearedAt: body.clearedAt || '' });
}

async function readLegacyState(client) {
  const [events, deleted] = await Promise.all([
    client.get(LEGACY_EVENTS_KEY),
    client.get(LEGACY_DELETED_KEY)
  ]);
  return core.mergeStates(
    { events: Array.isArray(events) || isRecord(events) ? events : [] },
    { events: [], deleted: isRecord(deleted) ? deleted : {} }
  );
}

async function getState(client = kv) {
  const stored = await client.get(STATE_KEY);
  return stored == null ? readLegacyState(client) : fromStoredState(stored);
}

const LUA_HELPERS = `
local function stamp(value)
  if type(value) ~= 'string' then return '' end
  local y, m, d, h, mi, s, ms = value:match('^(%d%d%d%d)-(%d%d)-(%d%d)T(%d%d):(%d%d):(%d%d)%.(%d%d%d)Z$')
  if not y then
    y, m, d, h, mi, s = value:match('^(%d%d%d%d)-(%d%d)-(%d%d)T(%d%d):(%d%d):(%d%d)Z$')
    ms = '000'
  end
  if not y then return '' end
  return y .. m .. d .. h .. mi .. s .. ms
end

local function stable(value)
  if value == cjson.null then return 'null' end
  local kind = type(value)
  if kind ~= 'table' then return cjson.encode(value) end
  local count = 0
  for _ in pairs(value) do count = count + 1 end
  if count > 0 and count == #value then
    local items = {}
    for i = 1, count do items[i] = stable(value[i]) end
    return '[' .. table.concat(items, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys)
  local items = {}
  for _, key in ipairs(keys) do items[#items + 1] = cjson.encode(key) .. ':' .. stable(value[key]) end
  return '{' .. table.concat(items, ',') .. '}'
end

local function decodeState(raw)
  local value = cjson.decode(raw)
  if type(value) ~= 'table' then return { events = {}, deleted = {}, clearedAt = '' } end
  local events = {}
  if type(value.events) == 'table' then
    for _, evt in pairs(value.events) do
      if type(evt) == 'table' and type(evt.id) == 'string' and evt.id ~= '' then events[evt.id] = evt end
    end
  end
  local deleted = {}
  if type(value.deleted) == 'table' then
    for id, valueAt in pairs(value.deleted) do
      if type(id) == 'string' and stamp(valueAt) ~= '' then deleted[id] = valueAt end
    end
  end
  return { events = events, deleted = deleted, clearedAt = stamp(value.clearedAt) ~= '' and value.clearedAt or '' }
end
`;

const MERGE_STATE_SCRIPT = LUA_HELPERS + `
local currentRaw = redis.call('GET', KEYS[1])
local current = currentRaw and decodeState(currentRaw) or decodeState(ARGV[2])
local incoming = decodeState(ARGV[1])

for id, evt in pairs(incoming.events) do
  local existing = current.events[id]
  if not existing then
    current.events[id] = evt
  else
    local a, b = stamp(existing.updatedAt), stamp(evt.updatedAt)
    if a < b or (a == b and stable(evt) > stable(existing)) then current.events[id] = evt end
  end
end
for id, valueAt in pairs(incoming.deleted) do
  if stamp(valueAt) > stamp(current.deleted[id] or '') then current.deleted[id] = valueAt end
end
if stamp(incoming.clearedAt) > stamp(current.clearedAt) then current.clearedAt = incoming.clearedAt end

local clearAt = stamp(current.clearedAt)
for id, evt in pairs(current.events) do
  local deletedAt = stamp(current.deleted[id] or '')
  local updatedAt = stamp(evt.updatedAt)
  if (deletedAt ~= '' and deletedAt >= updatedAt) or (clearAt ~= '' and clearAt >= updatedAt) then current.events[id] = nil end
end
local encoded = '{"events":' .. (next(current.events) and cjson.encode(current.events) or '{}') ..
  ',"deleted":' .. (next(current.deleted) and cjson.encode(current.deleted) or '{}') ..
  ',"clearedAt":' .. cjson.encode(current.clearedAt) .. '}'
redis.call('SET', KEYS[1], encoded)
return 'OK'
`;

const MARK_FIRED_SCRIPT = LUA_HELPERS + `
local currentRaw = redis.call('GET', KEYS[1])
local current = currentRaw and decodeState(currentRaw) or decodeState(ARGV[3])
local expectedList = cjson.decode(ARGV[1])
local firedAt = ARGV[2]
local marked = 0
for _, expected in ipairs(expectedList) do
  local evt = current.events[expected.id]
  if evt and evt.reminderFired ~= true and evt.date == expected.date
      and (evt.time or '') == (expected.time or '') and stable(evt.reminder) == stable(expected.reminder) then
    evt.reminderFired = true
    evt.reminderFiredAt = firedAt
    if stamp(evt.updatedAt) < stamp(firedAt) then evt.updatedAt = firedAt end
    marked = marked + 1
  end
end
if marked > 0 then
  local encoded = '{"events":' .. (next(current.events) and cjson.encode(current.events) or '{}') ..
    ',"deleted":' .. (next(current.deleted) and cjson.encode(current.deleted) or '{}') ..
    ',"clearedAt":' .. cjson.encode(current.clearedAt) .. '}'
  redis.call('SET', KEYS[1], encoded)
end
return marked
`;

async function mergeState(incoming, client = kv) {
  let legacy = toStoredState({});
  const stored = await client.get(STATE_KEY);
  if (stored == null) legacy = toStoredState(await readLegacyState(client));
  await client.eval(MERGE_STATE_SCRIPT, [STATE_KEY], [JSON.stringify(toStoredState(incoming)), JSON.stringify(legacy)]);
  return getState(client);
}

async function markRemindersFired(idsWithExpectedSchedule, firedAt, client = kv) {
  if (!Array.isArray(idsWithExpectedSchedule) || idsWithExpectedSchedule.length === 0) return 0;
  let legacy = toStoredState({});
  const stored = await client.get(STATE_KEY);
  if (stored == null) legacy = toStoredState(await readLegacyState(client));
  const marked = await client.eval(
    MARK_FIRED_SCRIPT,
    [STATE_KEY],
    [JSON.stringify(idsWithExpectedSchedule), firedAt, JSON.stringify(legacy)]
  );
  return Number(marked) || 0;
}

const ADD_SUBSCRIPTION_SCRIPT = `
local function loadMap(raw)
  local map = {}
  if raw then
    local value = cjson.decode(raw)
    if type(value) == 'table' then
      for _, sub in pairs(value) do
        if type(sub) == 'table' and type(sub.endpoint) == 'string' then map[sub.endpoint] = sub end
      end
    end
  end
  return map
end
local map = loadMap(redis.call('GET', KEYS[1]))
local incoming = cjson.decode(ARGV[1])
map[incoming.endpoint] = incoming
redis.call('SET', KEYS[1], next(map) and cjson.encode(map) or '{}')
return 1
`;

const REMOVE_SUBSCRIPTIONS_SCRIPT = `
local function loadMap(raw)
  local map = {}
  if raw then
    local value = cjson.decode(raw)
    if type(value) == 'table' then
      for _, sub in pairs(value) do
        if type(sub) == 'table' and type(sub.endpoint) == 'string' then map[sub.endpoint] = sub end
      end
    end
  end
  return map
end
local map = loadMap(redis.call('GET', KEYS[1]))
local endpoints = cjson.decode(ARGV[1])
local removed = 0
for _, endpoint in ipairs(endpoints) do
  if map[endpoint] then map[endpoint] = nil; removed = removed + 1 end
end
redis.call('SET', KEYS[1], next(map) and cjson.encode(map) or '{}')
return removed
`;

function validBase64Url(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9_-]+={0,2}$/.test(value) && value.replace(/=+$/, '').length % 4 !== 1;
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : '';
  } catch (_) {
    return '';
  }
}

function normalizeSubscription(value) {
  if (!isRecord(value)) return null;
  const endpoint = normalizeEndpoint(value.endpoint);
  const keys = isRecord(value.keys) ? value.keys : {};
  if (!endpoint || !validBase64Url(keys.p256dh) || !validBase64Url(keys.auth)) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

async function addSubscription(subscription, client = kv) {
  const normalized = normalizeSubscription(subscription);
  if (!normalized) throw new TypeError('Sottoscrizione non valida');
  await client.eval(ADD_SUBSCRIPTION_SCRIPT, [SUBS_KEY], [JSON.stringify(normalized)]);
}

async function removeSubscriptions(endpoints, client = kv) {
  const unique = [...new Set((Array.isArray(endpoints) ? endpoints : []).map(normalizeEndpoint).filter(Boolean))];
  if (unique.length === 0) return 0;
  const removed = await client.eval(REMOVE_SUBSCRIPTIONS_SCRIPT, [SUBS_KEY], [JSON.stringify(unique)]);
  return Number(removed) || 0;
}

async function listSubscriptions(client = kv) {
  const stored = await client.get(SUBS_KEY);
  const values = Array.isArray(stored) ? stored : isRecord(stored) ? Object.values(stored) : [];
  const byEndpoint = new Map();
  for (const value of values) {
    const sub = normalizeSubscription(value);
    if (sub) byEndpoint.set(sub.endpoint, sub);
  }
  return [...byEndpoint.values()];
}

function isValidBackupLabel(label) {
  if (typeof label !== 'string') return false;
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(label)) return true;
  const match = label.match(/^manual-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return false;
  const [, y, m, d, h, mi, s] = match;
  return core.isValidDate(`${y}-${m}-${d}`) && Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59;
}

const RECORD_BACKUP_SCRIPT = `
local labels = {}
local found = {}
local raw = redis.call('GET', KEYS[1])
if raw then
  local value = cjson.decode(raw)
  if type(value) == 'table' then
    for _, label in ipairs(value) do
      if type(label) == 'string' and not found[label] then labels[#labels + 1] = label; found[label] = true end
    end
  end
end
if not found[ARGV[1]] then labels[#labels + 1] = ARGV[1] end
table.sort(labels)
while #labels > tonumber(ARGV[2]) do
  local oldest = table.remove(labels, 1)
  redis.call('DEL', ARGV[3] .. oldest)
end
redis.call('SET', KEYS[1], cjson.encode(labels))
return #labels
`;

async function recordBackup(label, client = kv) {
  await client.eval(RECORD_BACKUP_SCRIPT, [BACKUP_INDEX_KEY], [label, String(KEEP_BACKUPS), BACKUP_PREFIX]);
}

async function createBackup(state, label, source, client = kv) {
  const savedAt = new Date().toISOString();
  const backup = { savedAt, source, ...fromStoredState(state) };
  const result = await client.set(`${BACKUP_PREFIX}${label}`, backup, { nx: true });
  const created = result === 'OK' || result === true;
  await recordBackup(label, client);
  return { label, created, backup: created ? backup : await client.get(`${BACKUP_PREFIX}${label}`) };
}

function monthlyBackupLabel(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

function manualBackupLabel(now = new Date()) {
  const stamp = now.toISOString().slice(0, 19);
  return `manual-${stamp.slice(0, 10).replace(/-/g, '')}-${stamp.slice(11).replace(/:/g, '')}`;
}

async function backupLabels(client = kv) {
  const index = await client.get(BACKUP_INDEX_KEY);
  const labels = Array.isArray(index) ? index.filter(isValidBackupLabel) : [];
  return [...new Set(labels)].sort().reverse();
}

async function getBackup(label, client = kv) {
  if (!isValidBackupLabel(label)) return null;
  return client.get(`${BACKUP_PREFIX}${label}`);
}

async function getLastBackupInfo(client = kv, labels) {
  const available = labels || await backupLabels(client);
  if (available.length === 0) return null;
  const backups = await Promise.all(available.map(async (label) => ({ label, backup: await client.get(`${BACKUP_PREFIX}${label}`) })));
  const latest = backups.filter((item) => item.backup && core.isValidIso(item.backup.savedAt))
    .sort((a, b) => Date.parse(b.backup.savedAt) - Date.parse(a.backup.savedAt) || b.label.localeCompare(a.label))[0];
  if (!latest) return null;
  return {
    label: latest.label,
    savedAt: latest.backup.savedAt,
    source: latest.backup.source || '',
    eventCount: Array.isArray(latest.backup.events) ? latest.backup.events.length : 0
  };
}

module.exports = {
  STATE_KEY, LEGACY_EVENTS_KEY, LEGACY_DELETED_KEY, SUBS_KEY, BACKUP_PREFIX, BACKUP_INDEX_KEY, KEEP_BACKUPS,
  SCRIPTS: { MERGE_STATE_SCRIPT, MARK_FIRED_SCRIPT, ADD_SUBSCRIPTION_SCRIPT, REMOVE_SUBSCRIPTIONS_SCRIPT, RECORD_BACKUP_SCRIPT },
  isRecord, toStoredState, fromStoredState, normalizeIncomingState, getState, mergeState, markRemindersFired,
  normalizeEndpoint, normalizeSubscription, addSubscription, removeSubscriptions, listSubscriptions,
  isValidBackupLabel, createBackup, monthlyBackupLabel, manualBackupLabel, backupLabels, getBackup, getLastBackupInfo
};
