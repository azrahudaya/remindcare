'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { DateTime } = require('luxon');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');

const TIMEZONE = 'Asia/Jakarta';
const PREGNANCY_MONTHS_LIMIT = 9;
const REMINDER_POLL_QUESTION = 'Sudah minum tablet FE hari ini?';
const REMINDER_POLL_OPTIONS = ['Sudah', 'Belum'];

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'remindcare.db');
let activeClient = null;

const QUESTIONS = [
  { field: 'name', text: 'Halo, aku RemindCare. Boleh tau nama ibu?' },
  { field: 'age', text: 'Usia berapa?' },
  { field: 'pregnancy_number', text: 'Kehamilan ke berapa?' },
  { field: 'hpht', text: 'HPHT (Hari Pertama Haid Terakhir) kapan? Contoh: 2024-01-31' },
  { field: 'routine_meds', text: 'Apakah rutin mengkonsumsi obat? (ya/tidak)', type: 'yesno' },
  { field: 'tea', text: 'Masih mengkonsumsi teh? (ya/tidak)', type: 'yesno' },
  { field: 'reminder_person', text: 'Siapa yang biasanya ngingetin buat minum obat?' },
  { field: 'allow_remindcare', text: 'Mau diingatkan RemindCare untuk minum obat? (ya/tidak)', type: 'yesno' },
  { field: 'reminder_time', text: 'RemindCare bakal mengingatkan tiap hari lewat WhatsApp. Mau diingatkan setiap jam berapa? (format 24 jam, contoh 17:00)', type: 'time' }
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

function buildReminderQuestion(user) {
  const rawName = user && user.name ? String(user.name).trim() : '';
  const displayName = rawName ? rawName : 'Bunda';
  return `Halo ${displayName} 🌼, sudah minum tablet FE hari ini?`;
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
}

async function getUser(db, waId) {
  return dbGet(db, 'SELECT * FROM users WHERE wa_id = ?', [waId]);
}

async function createUser(db, waId) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT INTO users (wa_id, status, onboarding_step, created_at, updated_at)
     VALUES (?, 'onboarding', 1, ?, ?)`,
    [waId, nowIso, nowIso]
  );
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
  if (normalized === 'sudah' || normalized === 'udah') {
    return 'Sudah';
  }
  if (normalized === 'belum') {
    return 'Belum';
  }
  return null;
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
  const poll = new Poll(buildReminderQuestion(user), REMINDER_POLL_OPTIONS, {
    allowMultipleAnswers: false
  });

  const message = await sendPoll(client, user.wa_id, poll);
  const dateKey = toDateKey(now);

  await updateUser(db, user.wa_id, {
    last_reminder_date: dateKey,
    last_poll_message_id: message.id ? message.id._serialized : null
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
    await sendText(client, user.wa_id, 'Aku belum menangkap jawabannya. Bisa diulang?');
    return;
  }

  const updates = {};

  if (question.type === 'yesno') {
    const yesNo = parseYesNo(text);
    if (yesNo === null) {
      await sendText(client, user.wa_id, 'Jawab dengan ya atau tidak, ya.');
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
        user.wa_id,
        'Baik, RemindCare tidak akan mengingatkan dulu. Kalau berubah pikiran, ketik start.'
      );
      return;
    }
  } else if (question.type === 'time') {
    const time = normalizeTimeInput(text);
    if (!time) {
      await sendText(client, user.wa_id, 'Format jam belum sesuai. Contoh: 17:00.');
      return;
    }
    updates[question.field] = time;
  } else if (question.field === 'hpht') {
    const parsed = parseHpht(text);
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
      `Siap, RemindCare akan mengingatkan setiap hari jam ${finalTime} WIB lewat polling.`
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

  const normalized = text.trim().toLowerCase();

  if (/^(help|menu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      'Perintah: start, stop, ubah jam 17:00.'
    );
    return true;
  }

  if (/^(stop|berhenti)$/.test(normalized)) {
    await updateUser(db, user.wa_id, { allow_remindcare: 0, status: 'paused' });
    await sendText(client, user.wa_id, 'Oke, pengingat dihentikan dulu.');
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
      `Siap, RemindCare aktif lagi jam ${user.reminder_time} WIB.`
    );
    return true;
  }

  if (/^(ubah|set)\s+jam\b/.test(normalized) || /^jam\b/.test(normalized)) {
    const match = normalized.match(/(?:ubah|set)?\s*jam\s*(.*)$/);
    const timeInput = match && match[1] ? match[1] : '';
    const time = normalizeTimeInput(timeInput);
    if (!time) {
      await sendText(client, user.wa_id, 'Format jam belum sesuai. Contoh: ubah jam 17:00.');
      return true;
    }
    await updateUser(db, user.wa_id, { reminder_time: time, allow_remindcare: 1, status: 'active' });
    await sendText(client, user.wa_id, `Jam pengingat diubah ke ${time} WIB.`);
    return true;
  }

  return false;
}

async function handleDailyResponse(db, client, user, response) {
  const dateKey = toDateKey(nowWib());
  await upsertReminderLog(db, user.wa_id, dateKey, response);

  if (response === 'Sudah') {
    await sendText(client, user.wa_id, 'Terima kasih. Semoga sehat selalu.');
  } else if (response === 'Belum') {
    await sendText(client, user.wa_id, 'Baik, jangan lupa diminum ya.');
  }
}

async function handleMessage(db, client, msg) {
  if (msg.from.endsWith('@g.us') || msg.isStatus) {
    return;
  }

  const text = msg.body ? msg.body.trim() : '';
  const waId = msg.from;
  const user = await getUser(db, waId);

  if (!user) {
    if (isGreeting(text)) {
      await sendText(
        client,
        waId,
        'Halo! Untuk mulai, ketik start ya.'
      );
      return;
    }

    await createUser(db, waId);
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
    await handleDailyResponse(db, client, user, pollAnswer);
    return;
  }

  await sendText(
    client,
    waId,
    'Aku siap membantu pengingat tablet FE. Ketik menu untuk melihat perintah.'
  );
}

async function handleVoteUpdate(db, client, vote) {
  const waId = vote.voter;
  const user = await getUser(db, waId);
  if (!user) {
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

  const response = vote.selectedOptions[0].name;
  if (!response) {
    return;
  }

  await handleDailyResponse(db, client, user, response);
}

async function startReminderLoop(db, client) {
  setInterval(async () => {
    try {
      const now = nowWib();
      const today = toDateKey(now);
      const currentTime = now.toFormat('HH:mm');

      const users = await dbAll(
        db,
        `SELECT * FROM users
         WHERE status = 'active'
         AND allow_remindcare = 1
         AND reminder_time IS NOT NULL`
      );

      for (const user of users) {
        if (user.reminder_time !== currentTime) {
          continue;
        }

        if (user.last_reminder_date === today) {
          continue;
        }

        if (!isPregnancyActive(user, now)) {
        await updateUser(db, user.wa_id, { status: 'completed', allow_remindcare: 0 });
        await sendText(
          client,
          user.wa_id,
          'Masa pengingat 9 bulan sudah selesai. Jika ingin lanjut, balas start.'
        );
          continue;
        }

        await sendDailyPoll(db, client, user, now);
      }
    } catch (err) {
      console.error('Gagal menjalankan pengingat:', err);
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

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
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

main().catch((err) => {
  console.error('RemindCare gagal dijalankan:', err);
});
