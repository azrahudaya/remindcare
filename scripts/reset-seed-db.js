"use strict";

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { DateTime } = require("luxon");

const TIMEZONE = "Asia/Jakarta";
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "remindcare.db");

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this);
    });
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function toDateKey(dt) {
  return dt.toFormat("yyyy-LL-dd");
}

function iso(dt) {
  return dt.toISO({ suppressMilliseconds: true });
}

function hashInt(input) {
  let h = 2166136261;
  const str = String(input || "");
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h +=
      (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return Math.abs(h >>> 0);
}

function randomResponseForDay(seed, dayIndex, responseRate = 0.7) {
  const r = (hashInt(`${seed}-resp-${dayIndex}`) % 1000) / 1000;
  if (r > responseRate) {
    return null;
  }
  const belumRoll = hashInt(`${seed}-belum-${dayIndex}`) % 100;
  return belumRoll < 22 ? "Belum" : "Sudah";
}

function buildReminderCreatedAt(dateKey, seed, dayIndex) {
  const minute = hashInt(`${seed}-minute-${dayIndex}`) % 13;
  const second = hashInt(`${seed}-second-${dayIndex}`) % 60;
  const hourOffset = hashInt(`${seed}-hour-${dayIndex}`) % 2;
  const hour = 20 + hourOffset;
  return `${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}:${String(second).padStart(2, "0")}+07:00`;
}

async function createSchema(db) {
  await run(
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
      last_labor_phase_message_date TEXT,
      last_reminder_text_date TEXT,
      last_delivery_poll_message_id TEXT,
      delivery_poll_stage TEXT,
      fe_poll_last_attempt_at TEXT,
      fe_poll_fail_count INTEGER NOT NULL DEFAULT 0,
      delivery_poll_last_attempt_at TEXT,
      delivery_poll_fail_count INTEGER NOT NULL DEFAULT 0,
      delivery_poll_intro_stage TEXT,
      delivery_poll_intro_date TEXT,
      delivery_hpl_poll_sent_date TEXT,
      delivery_hpl_response TEXT,
      delivery_hpl_response_at TEXT,
      delivery_hpl3_poll_sent_date TEXT,
      delivery_hpl3_response TEXT,
      delivery_hpl3_response_at TEXT,
      delivery_data_step INTEGER NOT NULL DEFAULT 0,
      delivery_date TEXT,
      delivery_date_iso TEXT,
      delivery_time TEXT,
      delivery_place TEXT,
      delivery_birth_attendant TEXT,
      delivery_with_complication TEXT,
      baby_gender TEXT,
      baby_birth_weight TEXT,
      mother_current_complaint TEXT,
      delivery_data_completed_at TEXT,
      postpartum_education_sent_at TEXT,
      mother_class_status TEXT,
      mother_class_started_at TEXT,
      mother_class_next_week INTEGER NOT NULL DEFAULT 1,
      mother_class_last_sent_week INTEGER,
      mother_class_last_sent_date TEXT,
      mother_class_step TEXT,
      mother_class_attended INTEGER,
      mother_class_location TEXT,
      mother_class_attendance_count INTEGER,
      mother_class_area TEXT,
      mother_class_completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS reminder_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      reminder_date TEXT NOT NULL,
      response TEXT,
      response_count INTEGER NOT NULL DEFAULT 0,
      response_sudah_count INTEGER NOT NULL DEFAULT 0,
      response_belum_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(wa_id, reminder_date)
    )`,
  );

  await run(
    db,
    `CREATE TABLE IF NOT EXISTS postpartum_visit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id TEXT NOT NULL,
      visit_code TEXT NOT NULL,
      visit_kind TEXT NOT NULL,
      visit_label TEXT NOT NULL,
      window_text TEXT NOT NULL,
      benefit_text TEXT NOT NULL,
      due_at TEXT NOT NULL,
      reminder_text_sent_at TEXT,
      sent_at TEXT,
      poll_message_id TEXT,
      last_attempt_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      response TEXT,
      response_count INTEGER NOT NULL DEFAULT 0,
      response_sudah_count INTEGER NOT NULL DEFAULT 0,
      response_belum_count INTEGER NOT NULL DEFAULT 0,
      response_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(wa_id, visit_code)
    )`,
  );
}

async function insertUser(db, fields) {
  const base = {
    name: null,
    age: null,
    pregnancy_number: null,
    hpht: null,
    hpht_iso: null,
    routine_meds: 1,
    tea: 0,
    reminder_person: "Suami",
    allow_remindcare: 1,
    reminder_time: "20:00",
    is_admin: 0,
    is_allowed: 1,
    is_blocked: 0,
    status: "active",
    onboarding_step: 0,
    last_reminder_date: null,
    last_poll_message_id: null,
    last_labor_phase_message_date: null,
    last_reminder_text_date: null,
    last_delivery_poll_message_id: null,
    delivery_poll_stage: null,
    fe_poll_last_attempt_at: null,
    fe_poll_fail_count: 0,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
    delivery_poll_intro_stage: null,
    delivery_poll_intro_date: null,
    delivery_hpl_poll_sent_date: null,
    delivery_hpl_response: null,
    delivery_hpl_response_at: null,
    delivery_hpl3_poll_sent_date: null,
    delivery_hpl3_response: null,
    delivery_hpl3_response_at: null,
    delivery_data_step: 0,
    delivery_date: null,
    delivery_date_iso: null,
    delivery_time: null,
    delivery_place: null,
    delivery_birth_attendant: null,
    delivery_with_complication: null,
    baby_gender: null,
    baby_birth_weight: null,
    mother_current_complaint: null,
    delivery_data_completed_at: null,
    postpartum_education_sent_at: null,
    mother_class_status: null,
    mother_class_started_at: null,
    mother_class_next_week: 1,
    mother_class_last_sent_week: null,
    mother_class_last_sent_date: null,
    mother_class_step: null,
    mother_class_attended: null,
    mother_class_location: null,
    mother_class_attendance_count: null,
    mother_class_area: null,
    mother_class_completed_at: null,
  };
  const row = { ...base, ...fields };
  const cols = Object.keys(row);
  const sql = `INSERT INTO users (${cols.join(", ")}) VALUES (${cols
    .map(() => "?")
    .join(", ")})`;
  await run(db, sql, cols.map((c) => row[c]));
}

async function seedReminderLogs(db, waId, startDateIso, endDateIso, rate, seed) {
  const start = DateTime.fromISO(startDateIso, { zone: TIMEZONE });
  const end = DateTime.fromISO(endDateIso, { zone: TIMEZONE });
  const totalDays = Math.floor(end.diff(start, "days").days) + 1;
  for (let i = 0; i < totalDays; i += 1) {
    const day = start.plus({ days: i });
    const dateKey = toDateKey(day);
    const response = randomResponseForDay(seed, i, rate);
    const createdAt = buildReminderCreatedAt(dateKey, seed, i);
    await run(
      db,
      `INSERT INTO reminder_logs (
        wa_id, reminder_date, response, response_count,
        response_sudah_count, response_belum_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        waId,
        dateKey,
        response,
        response ? 1 : 0,
        response === "Sudah" ? 1 : 0,
        response === "Belum" ? 1 : 0,
        createdAt,
      ],
    );
  }
}

async function seedPostpartumLogs(db, waId, rows) {
  for (const row of rows) {
    await run(
      db,
      `INSERT INTO postpartum_visit_logs (
        wa_id, visit_code, visit_kind, visit_label, window_text, benefit_text, due_at,
        reminder_text_sent_at, sent_at, poll_message_id, last_attempt_at, fail_count,
        response, response_count, response_sudah_count, response_belum_count, response_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        waId,
        row.code,
        row.kind,
        row.label,
        row.window,
        row.benefit || "Reminder kunjungan dari seed data",
        row.dueAt,
        row.sentAt || null,
        row.sentAt || null,
        `pp-${waId.replace(/[^0-9]/g, "")}-${row.code.toLowerCase()}`,
        row.sentAt || null,
        0,
        row.response || null,
        row.response ? 1 : 0,
        row.response === "Sudah" ? 1 : 0,
        row.response === "Belum" ? 1 : 0,
        row.responseAt || null,
        row.sentAt || row.dueAt,
        row.responseAt || row.sentAt || row.dueAt,
      ],
    );
  }
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let resetByDrop = false;
  if (fs.existsSync(DB_PATH)) {
    try {
      fs.unlinkSync(DB_PATH);
    } catch (err) {
      if (err && err.code === "EBUSY") {
        resetByDrop = true;
      } else {
        throw err;
      }
    }
  }

  const db = new sqlite3.Database(DB_PATH);
  if (resetByDrop) {
    await run(db, "DROP TABLE IF EXISTS postpartum_visit_logs");
    await run(db, "DROP TABLE IF EXISTS reminder_logs");
    await run(db, "DROP TABLE IF EXISTS users");
  }
  await createSchema(db);

  const users = [
    {
      wa_id: "62859117466725@c.us",
      name: "Susilawati",
      age: "22",
      pregnancy_number: "G1P0A0",
      hpht: "28-06-2025",
      hpht_iso: "2025-06-28",
      reminder_person: "RemindCare",
      is_admin: 1,
      status: "completed",
      delivery_hpl_poll_sent_date: "2026-03-22",
      delivery_hpl_response: "Sudah",
      delivery_hpl_response_at: "2026-03-23T22:00:00+07:00",
      delivery_date: "23-03-2026",
      delivery_date_iso: "2026-03-23",
      delivery_time: "22:00",
      delivery_place: "Rumah Sakit",
      delivery_birth_attendant: "Dokter",
      delivery_with_complication: "Tidak dengan penyulit",
      baby_gender: "Perempuan",
      baby_birth_weight: "3200 gram",
      mother_current_complaint: "Tidak ada",
      delivery_data_completed_at: "2026-03-23T22:25:00+07:00",
      postpartum_education_sent_at: "2026-03-24T08:00:00+07:00",
      mother_class_status: "completed",
      mother_class_started_at: "2026-03-01T09:00:00+07:00",
      mother_class_next_week: 2,
      mother_class_last_sent_week: 1,
      mother_class_last_sent_date: "2026-03-15",
      mother_class_attended: 1,
      mother_class_attendance_count: 1,
      mother_class_location: "Puskesmas",
      mother_class_area: "Wilayah Puskesmas Sukaraja",
      mother_class_completed_at: null,
      last_reminder_date: "2026-04-21",
      created_at: "2026-02-25T08:00:00+07:00",
      updated_at: "2026-04-21T20:30:00+07:00",
      logs: ["2026-02-25", "2026-04-21", 0.73, "susila"],
      postpartum: [
        {
          code: "KFKN1",
          kind: "KF + KN",
          label: "KF/KN 1",
          window: "6 jam - 2 hari (48 jam) pasca persalinan",
          dueAt: "2026-03-24T04:00:00+07:00",
          sentAt: "2026-03-24T08:00:00+07:00",
          response: "Sudah",
          responseAt: "2026-03-24T10:00:00+07:00",
        },
        {
          code: "KFKN2",
          kind: "KF + KN",
          label: "KF/KN 2",
          window: "3 - 7 hari pasca persalinan",
          dueAt: "2026-03-26T22:00:00+07:00",
          sentAt: "2026-03-26T22:05:00+07:00",
          response: "Belum",
          responseAt: "2026-03-26T22:20:00+07:00",
        },
        {
          code: "KFKN3",
          kind: "KF + KN",
          label: "KF/KN 3",
          window: "8 - 28 hari pasca persalinan",
          dueAt: "2026-03-31T09:00:00+07:00",
          sentAt: "2026-03-31T09:05:00+07:00",
          response: "Belum",
          responseAt: "2026-03-31T10:00:00+07:00",
        },
        {
          code: "KF4",
          kind: "KF",
          label: "KF 4",
          window: "29 - 42 hari pasca persalinan",
          dueAt: "2026-04-21T09:00:00+07:00",
          sentAt: "2026-04-21T09:10:00+07:00",
          response: "Sudah",
          responseAt: "2026-04-21T11:00:00+07:00",
        },
      ],
    },
    {
      wa_id: "6281112233445@c.us",
      name: "Nadia Rahma",
      age: "27",
      pregnancy_number: "G2P1A0",
      hpht: "15-09-2025",
      hpht_iso: "2025-09-15",
      reminder_time: "19:30",
      status: "active",
      mother_class_status: "active",
      mother_class_started_at: "2026-04-07T09:00:00+07:00",
      mother_class_next_week: 3,
      mother_class_last_sent_week: 2,
      mother_class_last_sent_date: "2026-04-14",
      mother_class_attended: 1,
      mother_class_attendance_count: 2,
      mother_class_location: "Kelurahan Cibiru",
      mother_class_area: "Posyandu Melati",
      created_at: "2026-03-10T09:15:00+07:00",
      updated_at: "2026-05-30T19:35:00+07:00",
      logs: ["2026-03-10", "2026-05-30", 0.68, "nadia"],
    },
    {
      wa_id: "6282233344455@c.us",
      name: "Rina Anggraini",
      age: "30",
      pregnancy_number: "G1P0A0",
      hpht: "18-08-2025",
      hpht_iso: "2025-08-18",
      reminder_time: "21:00",
      status: "active",
      delivery_hpl_poll_sent_date: "2026-05-20",
      delivery_hpl_response: "Belum",
      delivery_hpl_response_at: "2026-05-20T21:03:00+07:00",
      delivery_poll_stage: "week39_daily",
      created_at: "2026-03-01T11:00:00+07:00",
      updated_at: "2026-05-30T21:05:00+07:00",
      logs: ["2026-03-01", "2026-05-30", 0.62, "rina"],
    },
    {
      wa_id: "6285566677788@c.us",
      name: "Dewi Kurnia",
      age: "20",
      pregnancy_number: null,
      hpht: null,
      hpht_iso: null,
      reminder_time: null,
      status: "onboarding",
      onboarding_step: 4,
      allow_remindcare: 0,
      mother_class_status: null,
      created_at: "2026-05-29T14:10:00+07:00",
      updated_at: "2026-05-30T09:00:00+07:00",
      logs: null,
    },
  ];

  let totalReminderLogs = 0;
  for (const u of users) {
    const { logs, postpartum, ...userFields } = u;
    const createdAtIso = u.created_at || iso(DateTime.now().setZone(TIMEZONE));
    const updatedAtIso = u.updated_at || createdAtIso;
    await insertUser(db, {
      ...userFields,
      created_at: createdAtIso,
      updated_at: updatedAtIso,
    });

    if (Array.isArray(logs)) {
      const [startIso, endIso, rate, seed] = logs;
      const start = DateTime.fromISO(startIso, { zone: TIMEZONE });
      const end = DateTime.fromISO(endIso, { zone: TIMEZONE });
      totalReminderLogs += Math.floor(end.diff(start, "days").days) + 1;
      await seedReminderLogs(db, u.wa_id, startIso, endIso, rate, seed);
    }
    if (Array.isArray(postpartum) && postpartum.length > 0) {
      await seedPostpartumLogs(db, u.wa_id, postpartum);
    }
  }

  await close(db);
  console.log(`DB reset berhasil: ${DB_PATH}`);
  console.log(`Total users: ${users.length}`);
  console.log(`Total reminder logs: ${totalReminderLogs}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
