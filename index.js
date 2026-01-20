'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { DateTime } = require('luxon');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');

const TIMEZONE = 'Asia/Jakarta';
const PREGNANCY_MONTHS_LIMIT = 9;
const REMINDER_POLL_QUESTION = 'Sudah minum tablet FE hari ini? 💊😊';
const REMINDER_POLL_OPTIONS = ['Sudah ✅', 'Belum ⏳'];
const ENFORCE_ALLOWLIST = /^(1|true)$/i.test(process.env.ENFORCE_ALLOWLIST || '');
const ADMIN_WA_IDS = parseWaIdList(process.env.ADMIN_WA_IDS);
const ALLOWLIST_WA_IDS = parseWaIdList(process.env.ALLOWLIST_WA_IDS);
const MAX_MESSAGES_PER_MINUTE = Number(process.env.RATE_LIMIT_MAX_PER_MINUTE || 20);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.RATE_LIMIT_COOLDOWN_MS || 120000);
const REMINDER_LOG_RETENTION_DAYS = Number(process.env.REMINDER_LOG_RETENTION_DAYS || 180);
const DISABLE_SANDBOX = /^(1|true)$/i.test(process.env.PUPPETEER_NO_SANDBOX || '')
  || /^(1|true)$/i.test(process.env.DISABLE_CHROME_SANDBOX || '');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'remindcare.db');
let activeClient = null;
let reminderLoopRunning = false;
let lastCleanupDate = null;
const rateLimitState = new Map();

const QUESTIONS = [
  { field: 'name', text: 'Halo, aku RemindCare. Boleh tau nama ibu? 😊' },
  { field: 'age', text: 'Usia berapa? 🎂' },
  { field: 'pregnancy_number', text: 'Kehamilan ke berapa? 🤰' },
  { field: 'hpht', text: 'HPHT (Hari Pertama Haid Terakhir) kapan? Format tanggal-bulan-tahun, contoh: 31-01-2024 📅' },
  { field: 'routine_meds', text: 'Apakah rutin mengkonsumsi obat? (ya/tidak) 💊', type: 'yesno' },
  { field: 'tea', text: 'Masih mengkonsumsi teh? (ya/tidak) 🍵', type: 'yesno' },
  { field: 'reminder_person', text: 'Siapa yang biasanya ngingetin buat minum obat? 👥' },
  { field: 'allow_remindcare', text: 'Mau diingatkan RemindCare untuk minum obat? (ya/tidak) 🔔', type: 'yesno' },
  { field: 'reminder_time', text: 'RemindCare bakal mengingatkan tiap hari lewat WhatsApp. Mau diingatkan setiap jam berapa? (format 24 jam, contoh 17:00) ⏰', type: 'time' }
];

const REMINDER_TEMPLATES = [
  'Terima kasih sudah menjaga kesehatan hari ini. Tablet FE bantu tubuh tetap kuat. 💊💪',
  'Semangat ya, Bunda. Konsisten minum tablet FE bikin tubuh lebih bertenaga. ✨💊',
  'Kamu hebat sudah perhatian sama si kecil. Jangan lupa tablet FE ya. 🤰💗',
  'Sedikit konsisten tiap hari = hasil besar. Tetap minum tablet FE ya. 🌟💊',
  'Jaga diri dengan baik, ya. Tablet FE bantu penuhi kebutuhan zat besi. 🩺💊',
  'Semoga harimu lancar. Tablet FE membantu menjaga kesehatan ibu dan bayi. 🌿🤍',
  'Bunda luar biasa! Tablet FE membantu mencegah anemia. 💖💊',
  'Satu tablet FE sehari bantu tubuh tetap fit. 😊💊',
  'Zat besi penting untuk energi harianmu. Jangan lupa tablet FE. 🔋💊',
  'RemindCare selalu dukung kamu. Tetap semangat hari ini. 🤗💊'
];

function findBrowserExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';

  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe')
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveClient(candidate) {
  if (candidate && typeof candidate.sendMessage === 'function') {
    return candidate;
  }
  if (activeClient && typeof activeClient.sendMessage === 'function') {
    return activeClient;
  }
  return null;
}

function normalizeWaIdInput(input) {
  if (!input) {
    return null;
  }
  const trimmed = String(input).trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('@')) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  return `${digits}@c.us`;
}

function parseWaIdList(raw) {
  if (!raw) {
    return new Set();
  }
  const items = String(raw)
    .split(',')
    .map((item) => normalizeWaIdInput(item))
    .filter(Boolean);
  return new Set(items);
}

function isRateLimitEnabled() {
  return Number.isFinite(MAX_MESSAGES_PER_MINUTE) && MAX_MESSAGES_PER_MINUTE > 0;
}

function checkRateLimit(waId) {
  if (!isRateLimitEnabled()) {
    return { allowed: true };
  }

  const nowMs = Date.now();
  const windowMs = Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0
    ? RATE_LIMIT_WINDOW_MS
    : 60000;
  const cooldownMs = Number.isFinite(RATE_LIMIT_COOLDOWN_MS) && RATE_LIMIT_COOLDOWN_MS >= 0
    ? RATE_LIMIT_COOLDOWN_MS
    : 120000;

  const state = rateLimitState.get(waId) || { timestamps: [], blockedUntil: 0, lastWarnedAt: 0 };
  if (nowMs < state.blockedUntil) {
    const shouldWarn = nowMs - state.lastWarnedAt > 10000;
    if (shouldWarn) {
      state.lastWarnedAt = nowMs;
      rateLimitState.set(waId, state);
    }
    return { allowed: false, warn: shouldWarn };
  }

  state.timestamps = state.timestamps.filter((ts) => nowMs - ts < windowMs);
  state.timestamps.push(nowMs);

  if (state.timestamps.length > MAX_MESSAGES_PER_MINUTE) {
    state.blockedUntil = nowMs + cooldownMs;
    state.lastWarnedAt = nowMs;
    rateLimitState.set(waId, state);
    return { allowed: false, warn: true };
  }

  rateLimitState.set(waId, state);
  return { allowed: true };
}

function getDisplayName(user) {
  const rawName = user && user.name ? String(user.name).trim() : '';
  return rawName ? rawName : 'Bunda';
}

function getTimeGreeting(now) {
  const hour = now.hour;
  if (hour >= 4 && hour < 11) {
    return 'Selamat pagi ???';
  }
  if (hour >= 11 && hour < 15) {
    return 'Selamat siang ??';
  }
  if (hour >= 15 && hour < 18) {
    return 'Selamat sore ??';
  }
  return 'Selamat malam ??';
}

function pickReminderTemplate(user, dateKey) {
  const key = `${user && user.wa_id ? user.wa_id : ''}-${dateKey}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 2147483647;
  }
  const index = REMINDER_TEMPLATES.length > 0
    ? Math.abs(hash) % REMINDER_TEMPLATES.length
    : 0;
  return REMINDER_TEMPLATES[index] || '';
}

function buildReminderMessage(user, now) {
  const greeting = getTimeGreeting(now);
  const name = getDisplayName(user);
  const template = pickReminderTemplate(user, toDateKey(now));
  return `${greeting}, ${name}!\n${template}\nBaca artikel bermanfaat di remindcares.web.app 📚🌐`;
}

function buildReminderQuestion() {
  return REMINDER_POLL_QUESTION;
}

function sendText(client, chatId, text) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error('Client belum siap untuk mengirim pesan.');
    return null;
  }
  return resolved.sendMessage(chatId, text, { sendSeen: false }).catch((err) => {
    console.error('Gagal mengirim pesan:', err);
    return null;
  });
}

function sendPoll(client, chatId, poll) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error('Client belum siap untuk mengirim pesan.');
    return null;
  }
  return resolved.sendMessage(chatId, poll, { sendSeen: false }).catch((err) => {
    console.error('Gagal mengirim polling:', err);
    return null;
  });
}

function nowWib() {
  return DateTime.now().setZone(TIMEZONE);
}

function toDateKey(dt) {
  return dt.toFormat('yyyy-LL-dd');
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function ensureColumn(db, table, column, definition) {
  const rows = await dbAll(db, `PRAGMA table_info(${table})`);
  const exists = rows.some((row) => row.name === column);
  if (!exists) {
    await dbRun(db, `ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function ensureUserColumns(db) {
  await ensureColumn(db, 'users', 'is_admin', 'is_admin INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'users', 'is_allowed', 'is_allowed INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'users', 'is_blocked', 'is_blocked INTEGER NOT NULL DEFAULT 0');
}

async function initDb(db) {
  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT UNIQUE NOT NULL,
      name TEXT,
      age TEXT,
      pregnancy_number TEXT,
      hpht TEXT,
      hpht_iso TEXT,
      routine_meds INTEGER,
      tea INTEGER,
      reminder_person TEXT,
      allow_remindcare INTEGER,
      reminder_time TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_allowed INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'onboarding',
      onboarding_step INTEGER NOT NULL DEFAULT 1,
      last_reminder_date TEXT,
      last_poll_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );

  await dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      reminder_date TEXT NOT NULL,
      response TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(wa_id, reminder_date)
    )`
  );

  await ensureUserColumns(db);
}

async function getUser(db, waId) {
  return dbGet(db, 'SELECT * FROM users WHERE wa_id = ?', [waId]);
}

async function createUser(db, waId, options = {}) {
  const nowIso = nowWib().toISO();
  const isAdmin = options.is_admin ? 1 : 0;
  const isAllowed = options.is_allowed ? 1 : 0;
  const isBlocked = options.is_blocked ? 1 : 0;
  await dbRun(
    db,
    `INSERT INTO users (
      wa_id,
      status,
      onboarding_step,
      is_admin,
      is_allowed,
      is_blocked,
      created_at,
      updated_at
    )
     VALUES (?, 'onboarding', 1, ?, ?, ?, ?, ?)`,
    [waId, isAdmin, isAllowed, isBlocked, nowIso, nowIso]
  );
}

async function ensureUser(db, waId, seed = {}) {
  let user = await getUser(db, waId);
  let isNew = false;

  if (!user) {
    await createUser(db, waId, seed);
    user = await getUser(db, waId);
    isNew = true;
    return { user, isNew };
  }

  const updates = {};
  if (seed.is_admin && !user.is_admin) {
    updates.is_admin = 1;
  }
  if (seed.is_allowed && !user.is_allowed) {
    updates.is_allowed = 1;
  }
  if (seed.is_blocked && !user.is_blocked) {
    updates.is_blocked = 1;
  }

  if (Object.keys(updates).length > 0) {
    await updateUser(db, waId, updates);
    user = { ...user, ...updates };
  }

  return { user, isNew };
}

async function updateUser(db, waId, updates) {
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return;
  }

  const nowIso = nowWib().toISO();
  const setClause = keys.map((key) => `${key} = ?`).join(', ');
  const params = keys.map((key) => updates[key]);
  params.push(nowIso, waId);

  await dbRun(db, `UPDATE users SET ${setClause}, updated_at = ? WHERE wa_id = ?`, params);
}

function parseYesNo(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (/\b(ya|iya|yes|y|ok|mau|boleh)\b/.test(normalized)) {
    return true;
  }
  if (/\b(tidak|tdk|no|gak|ga|nggak|belum)\b/.test(normalized)) {
    return false;
  }
  return null;
}

function normalizeTimeInput(input) {
  if (!input) {
    return null;
  }
  const raw = input.trim().toLowerCase();
  const cleaned = raw.replace(/\s+/g, '').replace('.', ':');

  let hour;
  let minute;

  if (/^\d{1,2}$/.test(cleaned)) {
    hour = Number(cleaned);
    minute = 0;
  } else if (/^\d{1,2}:\d{1,2}$/.test(cleaned)) {
    const parts = cleaned.split(':');
    hour = Number(parts[0]);
    minute = Number(parts[1]);
  } else if (/^\d{3,4}$/.test(cleaned)) {
    if (cleaned.length === 3) {
      hour = Number(cleaned.slice(0, 1));
      minute = Number(cleaned.slice(1));
    } else {
      hour = Number(cleaned.slice(0, 2));
      minute = Number(cleaned.slice(2));
    }
  } else {
    return null;
  }

  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseHpht(input) {
  const raw = input ? input.trim() : '';
  if (!raw) {
    return { raw: '', iso: null };
  }

  const patterns = [
    { regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, order: 'ymd' },
    { regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, order: 'dmy' }
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern.regex);
    if (!match) {
      continue;
    }

    let year;
    let month;
    let day;

    if (pattern.order === 'ymd') {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    }

    const parsed = DateTime.fromObject({ year, month, day }, { zone: TIMEZONE });
    if (parsed.isValid) {
      return { raw, iso: parsed.toFormat('yyyy-LL-dd') };
    }
  }

  return { raw, iso: null };
}

function parsePollAnswer(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized.includes('sudah') || normalized.includes('udah')) {
    return 'Sudah';
  }
  if (normalized.includes('belum')) {
    return 'Belum';
  }
  return null;
}

function parseAdminCommand(text) {
  if (!text) {
    return null;
  }
  const match = text.trim().match(/^admin(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  const rest = (match[1] || '').trim();
  if (!rest) {
    return { action: 'help', args: [], rawArgs: '' };
  }
  const parts = rest.split(/\s+/);
  const action = parts[0].toLowerCase();
  const rawArgs = rest.slice(action.length).trim();
  return { action, args: parts.slice(1), rawArgs };
}

async function purgeOldLogs(db, retentionDays, now = nowWib()) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return 0;
  }
  const cutoff = now.minus({ days: retentionDays }).toFormat('yyyy-LL-dd');
  const result = await dbRun(
    db,
    'DELETE FROM reminder_logs WHERE reminder_date < ?',
    [cutoff]
  );
  return result && typeof result.changes === 'number' ? result.changes : 0;
}

async function getUserStats(db) {
  const total = await dbGet(db, 'SELECT COUNT(*) as count FROM users');
  const active = await dbGet(db, "SELECT COUNT(*) as count FROM users WHERE status = 'active'");
  const allowed = await dbGet(db, 'SELECT COUNT(*) as count FROM users WHERE is_allowed = 1');
  const blocked = await dbGet(db, 'SELECT COUNT(*) as count FROM users WHERE is_blocked = 1');
  return {
    total: total ? total.count : 0,
    active: active ? active.count : 0,
    allowed: allowed ? allowed.count : 0,
    blocked: blocked ? blocked.count : 0
  };
}

async function handleAdminCommand(db, client, user, text) {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return false;
  }

  if (!user.is_admin) {
    await sendText(client, user.wa_id, 'Perintah admin hanya untuk admin ya. 🔒');
    return true;
  }

  const { action, rawArgs } = parsed;
  if (action === 'help') {
    await sendText(
      client,
      user.wa_id,
      'Perintah admin: admin stats, admin allow <wa_id>, admin block <wa_id>, admin unblock <wa_id>, admin purge logs <hari>. 🛠️'
    );
    return true;
  }

  if (action === 'stats') {
    const stats = await getUserStats(db);
    await sendText(
      client,
      user.wa_id,
      `Stat user: total ${stats.total}, aktif ${stats.active}, allowed ${stats.allowed}, blocked ${stats.blocked}. 📊`
    );
    return true;
  }

  if (action === 'allow' || action === 'block' || action === 'unblock') {
    const target = normalizeWaIdInput(rawArgs);
    if (!target) {
      await sendText(client, user.wa_id, 'Format: admin allow|block|unblock <wa_id>. ✍️');
      return true;
    }

    const { user: targetUser } = await ensureUser(db, target);
    const updates = {};
    if (action === 'allow') {
      updates.is_allowed = 1;
      updates.is_blocked = 0;
    } else if (action === 'block') {
      updates.is_blocked = 1;
    } else if (action === 'unblock') {
      updates.is_blocked = 0;
    }

    await updateUser(db, targetUser.wa_id, updates);
    await sendText(
      client,
      user.wa_id,
      `OK ${action} ${targetUser.wa_id}. ✅`
    );
    return true;
  }

  if (action === 'purge') {
    const parts = rawArgs.split(/\s+/).filter(Boolean);
    let daysInput = null;
    if (parts.length === 1) {
      daysInput = parts[0];
    } else if (parts.length >= 2 && parts[0].toLowerCase() === 'logs') {
      daysInput = parts[1];
    }
    const days = daysInput ? Number(daysInput) : REMINDER_LOG_RETENTION_DAYS;
    const removed = await purgeOldLogs(db, days);
    await sendText(
      client,
      user.wa_id,
      `Log dibersihkan: ${removed} baris (retensi ${Number.isFinite(days) ? days : '-'} hari). 🧹`
    );
    return true;
  }

  await sendText(
    client,
    user.wa_id,
    'Perintah admin tidak dikenali. Ketik: admin help. 🤔'
  );
  return true;
}

function isGreeting(input) {
  if (!input) {
    return false;
  }
  const normalized = input.trim().toLowerCase();
  return /^(halo|hai|hi|hey|hei|assalamualaikum|salam)$/.test(normalized);
}

function shouldSkipToday(reminderTime, now) {
  const [hour, minute] = reminderTime.split(':').map(Number);
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now > scheduled;
}

function shouldSendNow(reminderTime, now) {
  const [hour, minute] = reminderTime.split(':').map(Number);
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now >= scheduled;
}

function isPregnancyActive(user, now) {
  if (!user.hpht_iso) {
    return true;
  }
  const start = DateTime.fromISO(user.hpht_iso, { zone: TIMEZONE });
  if (!start.isValid) {
    return true;
  }
  const end = start.plus({ months: PREGNANCY_MONTHS_LIMIT }).endOf('day');
  return now <= end;
}

async function upsertReminderLog(db, waId, dateKey, response) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO reminder_logs (wa_id, reminder_date, response, created_at)
     VALUES (?, ?, ?, ?)`,
    [waId, dateKey, response, nowIso]
  );

  if (response !== null && response !== undefined) {
    await dbRun(
      db,
      'UPDATE reminder_logs SET response = ? WHERE wa_id = ? AND reminder_date = ?',
      [response, waId, dateKey]
    );
  }
}

async function sendDailyPoll(db, client, user, now) {
  const reminderText = buildReminderMessage(user, now);
  await sendText(client, user.wa_id, reminderText);

  const poll = new Poll(buildReminderQuestion(), REMINDER_POLL_OPTIONS, {
    allowMultipleAnswers: false
  });

  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error('Gagal mengirim polling untuk:', user.wa_id);
    return;
  }
  const dateKey = toDateKey(now);

  await updateUser(db, user.wa_id, {
    last_reminder_date: dateKey,
    last_poll_message_id: message.id._serialized
  });

  await upsertReminderLog(db, user.wa_id, dateKey, null);
}

async function handleOnboardingAnswer(db, client, user, text) {
  const step = user.onboarding_step;
  const question = QUESTIONS[step - 1];

  if (!question) {
    await updateUser(db, user.wa_id, { status: 'active', onboarding_step: 0 });
    return;
  }

  if (!text) {
    await sendText(client, user.wa_id, 'Aku belum menangkap jawabannya. Bisa diulang? 🙂');
    return;
  }

  const updates = {};

  if (question.type === 'yesno') {
    const yesNo = parseYesNo(text);
    if (yesNo === null) {
      await sendText(client, user.wa_id, 'Jawab dengan ya atau tidak, ya. 🙏');
      return;
    }
    updates[question.field] = yesNo ? 1 : 0;

    if (question.field === 'allow_remindcare' && !yesNo) {
      await updateUser(db, user.wa_id, {
        ...updates,
        status: 'active',
        onboarding_step: 0,
        reminder_time: null
      });
      await sendText(
        client,
        user.wa_id,
        'Baik, RemindCare tidak akan mengingatkan dulu. Kalau berubah pikiran, ketik start. 👍'
      );
      return;
    }
  } else if (question.type === 'time') {
    const time = normalizeTimeInput(text);
    if (!time) {
      await sendText(client, user.wa_id, 'Format jam belum sesuai. Contoh: 17:00. ⏰');
      return;
    }
    updates[question.field] = time;
  } else if (question.field === 'hpht') {
    const parsed = parseHpht(text);
    if (!parsed.iso) {
      await sendText(
        client,
        user.wa_id,
        'Format HPHT belum sesuai. Contoh: 31-01-2024. 📅'
      );
      return;
    }
    updates.hpht = parsed.raw;
    updates.hpht_iso = parsed.iso;
  } else {
    updates[question.field] = text.trim();
  }

  const nextStep = step + 1;

  if (nextStep > QUESTIONS.length) {
    const now = nowWib();
    const reminderTime = updates.reminder_time || user.reminder_time;
    const shouldSkip = reminderTime ? shouldSkipToday(reminderTime, now) : false;
    const lastReminderDate = shouldSkip ? toDateKey(now) : null;

    await updateUser(db, user.wa_id, {
      ...updates,
      status: 'active',
      onboarding_step: 0,
      last_reminder_date: lastReminderDate
    });

    const finalTime = updates.reminder_time || user.reminder_time;
    await sendText(
      client,
      user.wa_id,
      `Siap! RemindCare akan mengingatkan setiap hari jam ${finalTime} WIB. ⏰✨`
    );
    return;
  }

  await updateUser(db, user.wa_id, { ...updates, onboarding_step: nextStep });
  await sendText(client, user.wa_id, QUESTIONS[nextStep - 1].text);
}

async function handleCommand(db, client, user, text) {
  if (!text) {
    return false;
  }

  if (await handleAdminCommand(db, client, user, text)) {
    return true;
  }

  const normalized = text.trim().toLowerCase();

  if (/^(help|menu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      'Perintah: start, stop, ubah jam 17:00. 📋'
    );
    return true;
  }

  if (/^(stop|berhenti)$/.test(normalized)) {
    await updateUser(db, user.wa_id, { allow_remindcare: 0, status: 'paused' });
    await sendText(client, user.wa_id, 'Oke, pengingat dihentikan dulu. ⏸️');
    return true;
  }

  if (/^(start|mulai)$/.test(normalized)) {
    if (!user.reminder_time) {
      await updateUser(db, user.wa_id, {
        allow_remindcare: 1,
        status: 'onboarding',
        onboarding_step: 9
      });
      await sendText(client, user.wa_id, QUESTIONS[8].text);
      return true;
    }

    await updateUser(db, user.wa_id, { allow_remindcare: 1, status: 'active' });
    await sendText(
      client,
      user.wa_id,
      `Siap, RemindCare aktif lagi jam ${user.reminder_time} WIB. ✅⏰`
    );
    return true;
  }

  if (/^(ubah|set)\s+jam\b/.test(normalized) || /^jam\b/.test(normalized)) {
    const match = normalized.match(/(?:ubah|set)?\s*jam\s*(.*)$/);
    const timeInput = match && match[1] ? match[1] : '';
    const time = normalizeTimeInput(timeInput);
    if (!time) {
      await sendText(client, user.wa_id, 'Format jam belum sesuai. Contoh: ubah jam 17:00. ⏰');
      return true;
    }
    await updateUser(db, user.wa_id, { reminder_time: time, allow_remindcare: 1, status: 'active' });
    await sendText(client, user.wa_id, `Jam pengingat diubah ke ${time} WIB. ✅⏰`);
    return true;
  }

  return false;
}

async function handleDailyResponse(db, client, user, response) {
  const dateKey = toDateKey(nowWib());
  await upsertReminderLog(db, user.wa_id, dateKey, response);

  if (response === 'Sudah') {
    await sendText(client, user.wa_id, 'Terima kasih. Semoga sehat selalu. 🌼');
  } else if (response === 'Belum') {
    await sendText(client, user.wa_id, 'Baik, jangan lupa diminum ya. 💊🙂');
  }
}

async function handleMessage(db, client, msg) {
  if (msg.from.endsWith('@g.us') || msg.isStatus) {
    return;
  }

  const text = msg.body ? msg.body.trim() : '';
  const waId = msg.from;
  const rateCheck = checkRateLimit(waId);
  if (!rateCheck.allowed) {
    if (rateCheck.warn) {
      await sendText(client, waId, 'Terlalu banyak pesan. Coba lagi sebentar. ⏳');
    }
    return;
  }

  const seed = {
    is_admin: ADMIN_WA_IDS.has(waId),
    is_allowed: ALLOWLIST_WA_IDS.has(waId)
  };
  const existingUser = await getUser(db, waId);
  if (!existingUser && ENFORCE_ALLOWLIST && !seed.is_allowed && !seed.is_admin) {
    await sendText(client, waId, 'Nomor ini belum diizinkan. Hubungi admin. 🚫');
    return;
  }
  if (!existingUser && isGreeting(text)) {
    await sendText(
      client,
      waId,
      'Halo! 👋 Aku RemindCare, bot pengingat tablet FE untuk ibu hamil supaya minum obat tepat waktu. 🤰💊\nUntuk mulai, ketik start ya. ✨\nCara pakai: jawab pertanyaan, pilih jam pengingat, lalu terima reminder harian. ⏰\nBaca artikel seputar kehamilan di remindcares.web.app 📚🌐'
    );
    return;
  }

  const { user, isNew } = await ensureUser(db, waId, seed);

  if (user.is_blocked) {
    return;
  }

  if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
    await sendText(client, waId, 'Nomor ini belum diizinkan. Hubungi admin. 🚫');
    return;
  }

  if (isNew) {
    await sendText(client, waId, QUESTIONS[0].text);
    return;
  }

  if (user.status === 'onboarding') {
    await handleOnboardingAnswer(db, client, user, text);
    return;
  }

  if (await handleCommand(db, client, user, text)) {
    return;
  }

  const pollAnswer = parsePollAnswer(text);
  if (pollAnswer) {
    const today = toDateKey(nowWib());
    if (user.last_reminder_date !== today) {
      await sendText(client, waId, 'Belum ada polling hari ini. Tunggu pengingat berikutnya ya. ⏳');
      return;
    }
    await handleDailyResponse(db, client, user, pollAnswer);
    return;
  }

  await sendText(
    client,
    waId,
    'Aku siap membantu pengingat tablet FE. Ketik menu untuk melihat perintah. 💬📋'
  );
}

async function handleVoteUpdate(db, client, vote) {
  const waId = vote.voter;
  const user = await getUser(db, waId);
  if (!user) {
    return;
  }

  if (user.is_blocked) {
    return;
  }

  if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
    return;
  }

  const pollMessageId = vote.parentMessage && vote.parentMessage.id
    ? vote.parentMessage.id._serialized
    : null;

  if (user.last_poll_message_id && pollMessageId && user.last_poll_message_id !== pollMessageId) {
    return;
  }

  if (!vote.selectedOptions || vote.selectedOptions.length === 0) {
    return;
  }

  const response = parsePollAnswer(vote.selectedOptions[0].name);
  if (!response) {
    return;
  }

  await handleDailyResponse(db, client, user, response);
}

async function startReminderLoop(db, client) {
  setInterval(async () => {
    if (reminderLoopRunning) {
      return;
    }
    reminderLoopRunning = true;
    try {
      const now = nowWib();
      const today = toDateKey(now);

      if (lastCleanupDate !== today) {
        try {
          await purgeOldLogs(db, REMINDER_LOG_RETENTION_DAYS, now);
        } catch (err) {
          console.error('Gagal membersihkan log lama:', err);
        }
        lastCleanupDate = today;
      }

      const users = await dbAll(
        db,
        `SELECT * FROM users
         WHERE status = 'active'
         AND allow_remindcare = 1
         AND reminder_time IS NOT NULL
         AND is_blocked = 0`
      );

      for (const user of users) {
        if (!shouldSendNow(user.reminder_time, now)) {
          continue;
        }

        if (user.last_reminder_date === today) {
          continue;
        }

        if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
          continue;
        }

        if (!isPregnancyActive(user, now)) {
          await updateUser(db, user.wa_id, { status: 'completed', allow_remindcare: 0 });
        await sendText(
          client,
          user.wa_id,
          'Masa pengingat 9 bulan sudah selesai. Jika ingin lanjut, balas start. 🎉'
        );
          continue;
        }

        await sendDailyPoll(db, client, user, now);
      }
    } catch (err) {
      console.error('Gagal menjalankan pengingat:', err);
    } finally {
      reminderLoopRunning = false;
    }
  }, 30000);
}

async function main() {
  ensureDataDir();
  const db = openDb();
  await initDb(db);

  const executablePath = findBrowserExecutable();
  if (executablePath) {
    console.log(`Menggunakan browser: ${executablePath}`);
  }

  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const disableSandbox = DISABLE_SANDBOX || runningAsRoot;
  if (runningAsRoot && !DISABLE_SANDBOX) {
    console.warn('Running as root, otomatis menonaktifkan sandbox Chromium.');
  }
  const puppeteerArgs = disableSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      ...(puppeteerArgs.length ? { args: puppeteerArgs } : {})
    }
  });
  activeClient = client;

  client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log('RemindCare siap digunakan.');
  });

  client.on('message', async (msg) => {
    try {
      await handleMessage(db, client, msg);
    } catch (err) {
      console.error('Gagal memproses pesan:', err);
    }
  });

  client.on('vote_update', async (vote) => {
    try {
      await handleVoteUpdate(db, client, vote);
    } catch (err) {
      console.error('Gagal memproses vote:', err);
    }
  });

  client.initialize();
  startReminderLoop(db, client);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('RemindCare gagal dijalankan:', err);
  });
}

module.exports = {
  parseYesNo,
  normalizeTimeInput,
  parseHpht,
  shouldSendNow
};



