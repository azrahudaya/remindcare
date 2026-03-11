"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const { DateTime } = require("luxon");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth, Poll } = require("whatsapp-web.js");

const TIMEZONE = "Asia/Jakarta";
const PREGNANCY_WEEKS_LIMIT = Number(process.env.PREGNANCY_WEEKS_LIMIT || 42);
const HPL_DAYS_FROM_HPHT = 280;
const DELIVERY_VALIDATION_START_WEEK = Number(
  process.env.DELIVERY_VALIDATION_START_WEEK || 39,
);
const REMINDER_POLL_QUESTION = "Sudah minum tablet FE hari ini? 💊😊";
const REMINDER_POLL_OPTIONS = ["Sudah ✅", "Belum ⏳"];
const DELIVERY_VALIDATION_POLL_QUESTION = "Apakah Ibu sudah melahirkan?";
const DELIVERY_VALIDATION_POLL_OPTIONS = [
  "Sudah melahirkan",
  "Belum melahirkan",
];
const DELIVERY_ARTICLE_URL = "https://remindcares.web.app";
const POSTPARTUM_POLL_OPTIONS = ["Sudah ✅", "Belum ⏳"];
const ENFORCE_ALLOWLIST = /^(1|true)$/i.test(
  process.env.ENFORCE_ALLOWLIST || "",
);
const ADMIN_WA_IDS = parseWaIdList(process.env.ADMIN_WA_IDS);
const ALLOWLIST_WA_IDS = parseWaIdList(process.env.ALLOWLIST_WA_IDS);
const MAX_MESSAGES_PER_MINUTE = Number(
  process.env.RATE_LIMIT_MAX_PER_MINUTE || 20,
);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_COOLDOWN_MS = Number(
  process.env.RATE_LIMIT_COOLDOWN_MS || 120000,
);
const MAX_POLL_RESPONSES_PER_DAY = Number(
  process.env.POLL_MAX_RESPONSES_PER_DAY || 2,
);
const ADMIN_WEB_ENABLED = !/^(0|false)$/i.test(
  process.env.ADMIN_WEB_ENABLED || "",
);
const ADMIN_WEB_PORT = Number(process.env.ADMIN_WEB_PORT || 3030);
const ADMIN_WEB_USER = process.env.ADMIN_WEB_USER || "admin";
const ADMIN_WEB_PASSWORD = (process.env.ADMIN_WEB_PASSWORD || "").trim();
const ADMIN_WEB_SESSION_TTL_MS = Number(
  process.env.ADMIN_WEB_SESSION_TTL_MS || 8 * 60 * 60 * 1000,
);
const REMINDER_LOG_RETENTION_DAYS = Number(
  process.env.REMINDER_LOG_RETENTION_DAYS || 180,
);
const POLL_RETRY_BASE_DELAY_MS = Number(
  process.env.POLL_RETRY_BASE_DELAY_MS || 5 * 60 * 1000,
);
const POLL_RETRY_MAX_DELAY_MS = Number(
  process.env.POLL_RETRY_MAX_DELAY_MS || 30 * 60 * 1000,
);
const REMINDER_LOOP_CONCURRENCY = Number(
  process.env.REMINDER_LOOP_CONCURRENCY || 10,
);
const ADMIN_WEB_COOKIE_SECURE =
  /^(1|true)$/i.test(process.env.ADMIN_WEB_COOKIE_SECURE || "") ||
  String(process.env.NODE_ENV || "").toLowerCase() === "production";
const DISABLE_SANDBOX =
  /^(1|true)$/i.test(process.env.PUPPETEER_NO_SANDBOX || "") ||
  /^(1|true)$/i.test(process.env.DISABLE_CHROME_SANDBOX || "");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "remindcare.db");
let activeClient = null;
let reminderLoopRunning = false;
let lastCleanupDate = null;
const rateLimitState = new Map();
const adminSessions = new Map();
const deleteConfirmState = new Map();
const editConfirmState = new Map();
const ACTION_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

const QUESTIONS = [
  { field: "name", text: "Halo, aku RemindCare. Boleh tau nama ibu? 😊" },
  { field: "age", text: "Usia berapa? 🎂" },
  { field: "pregnancy_number", text: "Kehamilan ke berapa? 🤰" },
  {
    field: "hpht",
    text: "HPHT (Hari Pertama Haid Terakhir) kapan? Format tanggal-bulan-tahun, contoh: 31-01-2024 📅",
  },
  {
    field: "routine_meds",
    text: "Apakah rutin mengkonsumsi obat? (ya/tidak) 💊",
    type: "yesno",
  },
  {
    field: "tea",
    text: "Masih mengkonsumsi teh? (ya/tidak) 🍵",
    type: "yesno",
  },
  {
    field: "reminder_person",
    text: "Siapa yang biasanya ngingetin buat minum obat? 👥",
  },
  {
    field: "allow_remindcare",
    text: "Mau diingatkan RemindCare untuk minum obat? (ya/tidak) 🔔",
    type: "yesno",
  },
  {
    field: "reminder_time",
    text: "RemindCare bakal mengingatkan tiap hari lewat WhatsApp. Mau diingatkan setiap jam berapa? (format 24 jam, contoh 17:00) ⏰",
    type: "time",
  },
];

const DELIVERY_QUESTIONS = [
  {
    field: "delivery_date",
    text: "Terima kasih infonya, Ibu. Tanggal melahirkan kapan? (contoh: 31-01-2026)",
    type: "date",
  },
  {
    field: "delivery_time",
    text: "Jam melahirkan pukul berapa? (format 24 jam, contoh: 14:30)",
    type: "time",
  },
  {
    field: "delivery_place",
    text: "Tempat melahirkan di mana? (rumah/puskesmas/klinik/rumah sakit)",
  },
  {
    field: "delivery_birth_attendant",
    text: "Siapa penolong persalinannya? (contoh: bidan/dokter)",
  },
  {
    field: "delivery_with_complication",
    text: "Apakah persalinan dengan penyulit? (ya/tidak)",
    type: "yesno",
  },
  {
    field: "baby_gender",
    text: "Jenis kelamin bayi apa? (laki-laki/perempuan)",
  },
  {
    field: "baby_birth_weight",
    text: "Berat badan bayi saat lahir berapa gram? (contoh: 3200 gram)",
    type: "weight_gram",
  },
  {
    field: "mother_current_complaint",
    text: "Apakah ada keluhan Ibu saat ini? (jika tidak ada, tulis: tidak ada)",
  },
];

const LABOR_PHASE_MESSAGES = {
  37: "Minggu ke-37: Ini fase awal aterm. Tetap tenang, istirahat cukup, dan perhatikan kontraksi teratur.",
  38: "Minggu ke-38: Ini fase persiapan akhir. Pastikan perlengkapan persalinan siap dan pendamping mudah dihubungi.",
  39: "Minggu ke-39: Ini fase menunggu persalinan aktif. Pantau gerakan janin dan tanda mulas yang makin teratur.",
  40: "Minggu ke-40: Ini fase HPL. Sebagian ibu melahirkan tepat HPL, sebagian sedikit sebelum/sesudah HPL.",
  41: "Minggu ke-41: Ini fase pemantauan lanjutan. Tetap kontrol sesuai anjuran tenaga kesehatan dan waspadai tanda bahaya.",
};

const POSTPARTUM_VISIT_SCHEDULES = [
  {
    code: "KFKN1",
    kind: "KF + KN",
    label: "KF/KN 1",
    startHours: 6,
    endHours: 48,
    windowText: "6 jam - 2 hari (48 jam) pasca persalinan",
    focusText:
      "Ibu: cegah perdarahan, deteksi infeksi, cek rahim & tekanan darah. Bayi: cek napas, suhu/kehangatan, tali pusat, dan menyusu dini.",
  },
  {
    code: "KFKN2",
    kind: "KF + KN",
    label: "KF/KN 2",
    startHours: 72,
    endHours: 168,
    windowText: "3 - 7 hari pasca persalinan",
    focusText:
      "Ibu: pastikan ASI/laktasi lancar dan tidak ada bahaya nifas. Bayi: pantau infeksi, kuning, berat badan, dan kemampuan menyusu.",
  },
  {
    code: "KFKN3",
    kind: "KF + KN",
    label: "KF/KN 3",
    startHours: 192,
    endHours: 672,
    windowText: "8 - 28 hari pasca persalinan",
    focusText:
      "Ibu: pemulihan fisik dan konseling KB pascasalin. Bayi: pantau pertumbuhan, kenaikan berat badan, dan dukungan ASI eksklusif.",
  },
  {
    code: "KF4",
    kind: "KF",
    label: "KF 4",
    startHours: 696,
    endHours: 1008,
    windowText: "29 - 42 hari pasca persalinan",
    focusText:
      "Pemeriksaan kesehatan umum akhir masa nifas dan pemantapan metode KB.",
  },
];

const POSTPARTUM_VISIT_BY_CODE = new Map(
  POSTPARTUM_VISIT_SCHEDULES.map((item) => [item.code, item]),
);
const LEGACY_POSTPARTUM_VISIT_GROUPS = [
  { code: "KFKN1", legacyCodes: ["KF1", "KN1"] },
  { code: "KFKN2", legacyCodes: ["KF2", "KN2"] },
  { code: "KFKN3", legacyCodes: ["KF3", "KN3"] },
];

const REMINDER_TEMPLATES = [
  "Terima kasih sudah menjaga kesehatan hari ini. Tablet FE bantu tubuh tetap kuat. 💊💪",
  "Semangat ya, Bunda. Konsisten minum tablet FE bikin tubuh lebih bertenaga. ✨💊",
  "Kamu hebat sudah perhatian sama si kecil. Jangan lupa tablet FE ya. 🤰💗",
  "Sedikit konsisten tiap hari = hasil besar. Tetap minum tablet FE ya. 🌟💊",
  "Jaga diri dengan baik, ya. Tablet FE bantu penuhi kebutuhan zat besi. 🩺💊",
  "Semoga harimu lancar. Tablet FE membantu menjaga kesehatan ibu dan bayi. 🌿🤍",
  "Bunda luar biasa! Tablet FE membantu mencegah anemia. 💖💊",
  "Satu tablet FE sehari bantu tubuh tetap fit. 😊💊",
  "Zat besi penting untuk energi harianmu. Jangan lupa tablet FE. 🔋💊",
  "RemindCare selalu dukung kamu. Tetap semangat hari ini. 🤗💊",
];

function findBrowserExecutable() {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
  const programFilesX86 =
    process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const candidates = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(
      programFilesX86,
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Chromium", "Application", "chrome.exe"),
    path.join(programFilesX86, "Chromium", "Application", "chrome.exe"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveClient(candidate) {
  if (candidate && typeof candidate.sendMessage === "function") {
    return candidate;
  }
  if (activeClient && typeof activeClient.sendMessage === "function") {
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
  if (trimmed.includes("@")) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, "");
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
    .split(",")
    .map((item) => normalizeWaIdInput(item))
    .filter(Boolean);
  return new Set(items);
}

function isUnsupportedDirectTarget(chatId) {
  if (!chatId) {
    return true;
  }
  const normalized = String(chatId).trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized.endsWith("@newsletter") ||
    normalized.endsWith("@broadcast") ||
    normalized.endsWith("@g.us")
  );
}

function isRateLimitEnabled() {
  return (
    Number.isFinite(MAX_MESSAGES_PER_MINUTE) && MAX_MESSAGES_PER_MINUTE > 0
  );
}

function getMaxPollResponsesPerDay() {
  return Number.isFinite(MAX_POLL_RESPONSES_PER_DAY) &&
    MAX_POLL_RESPONSES_PER_DAY > 0
    ? MAX_POLL_RESPONSES_PER_DAY
    : null;
}

function isEditDataCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    /^(edit|ubah|reset)\s+(data|profil|jawaban)$/.test(normalized) ||
    /^(edit|ubah|reset)\s+data\s+(profil|diri)$/.test(normalized)
  );
}

function isEditDeliveryCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(edit|ubah|reset)\s+(data\s+)?persalinan$/.test(normalized);
}

function isDeliveryCheckCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "persalinan" ||
    /^(cek|konfirmasi|status)\s+persalinan$/.test(normalized)
  );
}

function isEditMenuCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(edit|ubah|reset)$/.test(normalized);
}

function isCancelCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(batal|cancel)(\s+edit)?$/.test(normalized);
}

function isAlwaysCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return (
    /^(help|menu|info|informasi|about|abotu|website|delete|hapus|batal|cancel)$/.test(
      normalized,
    ) ||
    isDeliveryCheckCommand(normalized) ||
    isEditDataCommand(normalized) ||
    isEditDeliveryCommand(normalized) ||
    isEditMenuCommand(normalized)
  );
}

function checkDeleteConfirmation(waId) {
  const nowMs = Date.now();
  const existing = deleteConfirmState.get(waId);
  if (existing && nowMs - existing < ACTION_CONFIRM_WINDOW_MS) {
    deleteConfirmState.delete(waId);
    return true;
  }
  deleteConfirmState.set(waId, nowMs);
  return false;
}

function checkEditConfirmation(waId, action) {
  const nowMs = Date.now();
  const key = `${waId}::${action}`;
  const existing = editConfirmState.get(key);
  if (existing && nowMs - existing < ACTION_CONFIRM_WINDOW_MS) {
    editConfirmState.delete(key);
    return true;
  }
  editConfirmState.set(key, nowMs);
  return false;
}

function clearPendingConfirmation(waId) {
  let cleared = false;
  if (deleteConfirmState.has(waId)) {
    deleteConfirmState.delete(waId);
    cleared = true;
  }
  const prefix = `${waId}::`;
  for (const key of editConfirmState.keys()) {
    if (key.startsWith(prefix)) {
      editConfirmState.delete(key);
      cleared = true;
    }
  }
  return cleared;
}

function checkRateLimit(waId) {
  if (!isRateLimitEnabled()) {
    return { allowed: true };
  }

  const nowMs = Date.now();
  const windowMs =
    Number.isFinite(RATE_LIMIT_WINDOW_MS) && RATE_LIMIT_WINDOW_MS > 0
      ? RATE_LIMIT_WINDOW_MS
      : 60000;
  const cooldownMs =
    Number.isFinite(RATE_LIMIT_COOLDOWN_MS) && RATE_LIMIT_COOLDOWN_MS >= 0
      ? RATE_LIMIT_COOLDOWN_MS
      : 120000;

  const state = rateLimitState.get(waId) || {
    timestamps: [],
    blockedUntil: 0,
    lastWarnedAt: 0,
  };
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
  const rawName = user && user.name ? String(user.name).trim() : "";
  return rawName ? rawName : "Bunda";
}

function getTimeGreeting(now) {
  const hour = now.hour;
  if (hour >= 4 && hour < 11) {
    return "Selamat pagi ???";
  }
  if (hour >= 11 && hour < 15) {
    return "Selamat siang ??";
  }
  if (hour >= 15 && hour < 18) {
    return "Selamat sore ??";
  }
  return "Selamat malam ??";
}

function pickReminderTemplate(user, dateKey) {
  const key = `${user && user.wa_id ? user.wa_id : ""}-${dateKey}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 2147483647;
  }
  const index =
    REMINDER_TEMPLATES.length > 0
      ? Math.abs(hash) % REMINDER_TEMPLATES.length
      : 0;
  return REMINDER_TEMPLATES[index] || "";
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

function getHphtDate(user) {
  if (!user || !user.hpht_iso) {
    return null;
  }
  const parsed = DateTime.fromISO(String(user.hpht_iso), { zone: TIMEZONE });
  if (!parsed.isValid) {
    return null;
  }
  return parsed.startOf("day");
}

function getHplDate(user) {
  const hpht = getHphtDate(user);
  if (!hpht) {
    return null;
  }
  return hpht.plus({ days: HPL_DAYS_FROM_HPHT }).startOf("day");
}

function getGestationalWeek(user, now) {
  const hpht = getHphtDate(user);
  if (!hpht) {
    return null;
  }
  const diffDays = Math.floor(now.startOf("day").diff(hpht, "days").days);
  if (!Number.isFinite(diffDays) || diffDays < 0) {
    return null;
  }
  return Math.floor(diffDays / 7) + 1;
}

function formatDateId(value) {
  if (!value) {
    return "-";
  }
  const parsed =
    typeof value === "string"
      ? DateTime.fromISO(value, { zone: TIMEZONE })
      : value.setZone(TIMEZONE);
  if (!parsed || !parsed.isValid) {
    return String(value);
  }
  return parsed.setLocale("id").toFormat("dd LLLL yyyy");
}

function formatDateTimeId(value) {
  if (!value) {
    return "-";
  }
  const parsed =
    typeof value === "string"
      ? DateTime.fromISO(value, { zone: TIMEZONE })
      : value.setZone(TIMEZONE);
  if (!parsed || !parsed.isValid) {
    return String(value);
  }
  return parsed.setLocale("id").toFormat("dd LLLL yyyy HH:mm");
}

function toYesNoLabel(value) {
  if (value === 1 || value === true || String(value) === "1") {
    return "Ya";
  }
  if (value === 0 || value === false || String(value) === "0") {
    return "Tidak";
  }
  return "-";
}

function getReminderStatusLabel(user) {
  if (!user) {
    return "-";
  }
  if (user.status === "completed") {
    return "Selesai";
  }
  if (Number(user.allow_remindcare) === 1 && user.status === "active") {
    return "Aktif";
  }
  if (user.status === "paused" || Number(user.allow_remindcare) === 0) {
    return "Dijeda";
  }
  if (user.status === "onboarding") {
    return "Onboarding";
  }
  return String(user.status || "-");
}

function getStatusIcon(status) {
  if (status === "done") {
    return "✅";
  }
  if (status === "fail") {
    return "❌";
  }
  return "🔄";
}

function withStatusIcon(status, text) {
  return `${getStatusIcon(status)} ${text}`;
}

function buildPostpartumVisitStatusText(log, dueAt, now) {
  if (log && log.response === "Sudah") {
    return withStatusIcon(
      "done",
      `Tercapai (${formatDateTimeId(log.response_at)})`,
    );
  }
  if (log && log.response === "Belum") {
    return withStatusIcon(
      "fail",
      `Belum tercapai (${formatDateTimeId(log.response_at)})`,
    );
  }
  if (!dueAt || !dueAt.isValid) {
    return withStatusIcon("wait", "Menunggu data persalinan");
  }
  if (now < dueAt) {
    return withStatusIcon("wait", "Belum masuk jadwal");
  }
  if (log && log.sent_at) {
    return withStatusIcon("wait", "Menunggu konfirmasi");
  }
  return withStatusIcon("wait", "Menunggu pengingat");
}

function buildUserInfoMessage(user, postpartumLogs, now = nowWib()) {
  const name = getDisplayName(user);
  const hpht = getHphtDate(user);
  const hpl = getHplDate(user);
  const week = getGestationalWeek(user, now);
  const reminderTime = user && user.reminder_time ? `${user.reminder_time} WIB` : "-";
  const deliveryAt = getDeliveryDateTime(user);
  const today = toDateKey(now);
  const deliveryValidationActive = isDeliveryValidationActive(user, now);
  const pendingDeliveryStage = getPendingDeliveryPollStage(user);
  const deliveryConfirmed = hasConfirmedDelivery(user);
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const logByCode = new Map(
    (Array.isArray(postpartumLogs) ? postpartumLogs : []).map((item) => [
      item.visit_code,
      item,
    ]),
  );

  const visitLines = [];
  let confirmedVisits = 0;
  let failedVisits = 0;
  for (let i = 0; i < POSTPARTUM_VISIT_SCHEDULES.length; i += 1) {
    const visit = POSTPARTUM_VISIT_SCHEDULES[i];
    const log = logByCode.get(visit.code) || null;
    if (log && log.response === "Sudah") {
      confirmedVisits += 1;
    } else if (log && log.response === "Belum") {
      failedVisits += 1;
    }
    const dueAt = deliveryAt ? getPostpartumDueAt(deliveryAt, visit) : null;
    const dueText = dueAt ? formatDateTimeId(dueAt) : "-";
    const statusText = buildPostpartumVisitStatusText(log, dueAt, now);
    const goalText = String(visit.focusText || "-").trim();
    visitLines.push(
      `${i + 1}. *${visit.label}* (${visit.windowText})\nJadwal: ${dueText}\nStatus: ${statusText}\nGoal: ${goalText}`,
    );
  }

  const deliveryStep = Number(user && user.delivery_data_step ? user.delivery_data_step : 0);
  const collectingDeliveryText =
    Number.isFinite(deliveryStep) && deliveryStep > 0
      ? withStatusIcon(
          "wait",
          `Sedang isi data persalinan (step ${deliveryStep}/${DELIVERY_QUESTIONS.length})`,
        )
      : withStatusIcon("done", "Data persalinan tidak sedang diisi");

  const accountStatusLabel = getReminderStatusLabel(user);
  const accountStatusText =
    accountStatusLabel === "Aktif" || accountStatusLabel === "Selesai"
      ? withStatusIcon("done", accountStatusLabel)
      : accountStatusLabel === "Dijeda"
        ? withStatusIcon("fail", accountStatusLabel)
        : withStatusIcon("wait", accountStatusLabel);

  const feReminderText =
    Number(user && user.allow_remindcare) === 1 &&
    user &&
    user.status === "active" &&
    user.reminder_time
      ? withStatusIcon("done", `Aktif setiap hari jam ${user.reminder_time} WIB`)
      : !user || !user.reminder_time
        ? withStatusIcon("wait", "Jam pengingat belum disetel")
        : withStatusIcon("fail", "Pengingat FE sedang tidak aktif");

  let deliveryReminderText = withStatusIcon("wait", "Menunggu data HPHT");
  if (deliveryConfirmed) {
    deliveryReminderText = withStatusIcon(
      "done",
      "Validasi persalinan selesai (sudah terkonfirmasi melahirkan)",
    );
  } else if (deliveryValidationActive) {
    if (pendingDeliveryStage) {
      deliveryReminderText = withStatusIcon(
        "wait",
        "Poll validasi persalinan terkirim, menunggu jawaban",
      );
    } else if (user && user.delivery_hpl_poll_sent_date === today) {
      deliveryReminderText = withStatusIcon(
        "done",
        "Poll validasi persalinan hari ini sudah dikirim",
      );
    } else {
      deliveryReminderText = withStatusIcon(
        "wait",
        "Pengingat validasi persalinan aktif, menunggu jadwal kirim",
      );
    }
  } else if (week) {
    deliveryReminderText = withStatusIcon(
      "wait",
      `Belum masuk fase validasi persalinan (minggu ${week}/${startWeek})`,
    );
  }

  let postpartumReminderText = withStatusIcon("wait", "Menunggu data persalinan");
  if (deliveryAt) {
    if (confirmedVisits === POSTPARTUM_VISIT_SCHEDULES.length) {
      postpartumReminderText = withStatusIcon(
        "done",
        "Semua goal kunjungan KF/KN sudah tercapai",
      );
    } else if (failedVisits > 0) {
      postpartumReminderText = withStatusIcon(
        "fail",
        `Ada ${failedVisits} kunjungan yang belum tercapai`,
      );
    } else {
      postpartumReminderText = withStatusIcon(
        "wait",
        `Progres berjalan (${confirmedVisits}/${POSTPARTUM_VISIT_SCHEDULES.length})`,
      );
    }
  }

  const lines = [
    `*Info Penting RemindCare* - ${name}`,
    "",
    "*Status Pengingat*",
    `*Status akun:* ${accountStatusText}`,
    `*Pengingat tablet FE:* ${feReminderText}`,
    `*Pengingat validasi persalinan:* ${deliveryReminderText}`,
    `*Pengingat kunjungan KF/KN:* ${postpartumReminderText}`,
    "",
    "*Data Kehamilan*",
    `*Jam pengingat tablet FE:* ${reminderTime}`,
    `*HPHT:* ${formatDateId(hpht || (user ? user.hpht_iso : null))}`,
    `*HPL:* ${formatDateId(hpl)}`,
    `*Usia kehamilan saat ini:* ${week ? `${week} minggu` : "-"}`,
    "",
    "*Data Persalinan*",
    `*Status input persalinan:* ${collectingDeliveryText}`,
    `*Tanggal/jam persalinan:* ${deliveryAt ? formatDateTimeId(deliveryAt) : "-"}`,
    `*Tempat persalinan:* ${user && user.delivery_place ? user.delivery_place : "-"}`,
    `*Penolong persalinan:* ${
      user && user.delivery_birth_attendant ? user.delivery_birth_attendant : "-"
    }`,
    `*Penyulit persalinan:* ${
      user && user.delivery_with_complication ? user.delivery_with_complication : "-"
    }`,
    `*Jenis kelamin bayi:* ${user && user.baby_gender ? user.baby_gender : "-"}`,
    `*BB lahir bayi:* ${user && user.baby_birth_weight ? user.baby_birth_weight : "-"}`,
    "",
    "*Goal & Progres Kunjungan KF/KN*",
    `*Goal kunjungan:* ${POSTPARTUM_VISIT_SCHEDULES.length} kunjungan`,
    `*Progres tercapai:* ${confirmedVisits}/${POSTPARTUM_VISIT_SCHEDULES.length}`,
    "",
    "*Rincian Kunjungan*",
    ...visitLines,
    "",
    "*Catatan Harian*",
    `*Obat rutin:* ${
      toYesNoLabel(user ? user.routine_meds : null) === "Ya"
        ? withStatusIcon("done", "Ya")
        : toYesNoLabel(user ? user.routine_meds : null) === "Tidak"
          ? withStatusIcon("fail", "Tidak")
          : withStatusIcon("wait", "-")
    }`,
    `*Konsumsi teh:* ${
      toYesNoLabel(user ? user.tea : null) === "Ya"
        ? withStatusIcon("done", "Ya")
        : toYesNoLabel(user ? user.tea : null) === "Tidak"
          ? withStatusIcon("fail", "Tidak")
          : withStatusIcon("wait", "-")
    }`,
  ];

  return lines.join("\n");
}

function buildLaborPhaseMessage(user, now) {
  if (
    user &&
    (user.delivery_hpl_response === "Sudah" ||
      user.delivery_hpl3_response === "Sudah")
  ) {
    return null;
  }
  const week = getGestationalWeek(user, now);
  if (!week || week < 37 || week > 41) {
    return null;
  }
  const template = LABOR_PHASE_MESSAGES[week];
  if (!template) {
    return null;
  }
  if (week !== 40) {
    return template;
  }
  const hpl = getHplDate(user);
  const hplText = hpl ? formatDateId(hpl) : "-";
  return `${template}\nPerkiraan HPL Ibu: ${hplText}.`;
}

function getDeliveryValidationStageDue(user, now) {
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const week = getGestationalWeek(user, now);
  if (!week || week < startWeek) {
    return null;
  }
  if (hasConfirmedDelivery(user)) {
    return null;
  }

  const today = toDateKey(now.startOf("day"));
  return user.delivery_hpl_poll_sent_date === today ? null : "week39_daily";
}

function isDeliveryValidationActive(user, now) {
  const startWeek =
    Number.isFinite(DELIVERY_VALIDATION_START_WEEK) &&
    DELIVERY_VALIDATION_START_WEEK > 0
      ? Math.floor(DELIVERY_VALIDATION_START_WEEK)
      : 39;
  const week = getGestationalWeek(user, now);
  if (!week || week < startWeek) {
    return false;
  }
  return !hasConfirmedDelivery(user);
}

function getPendingDeliveryPollStage(user) {
  if (!user || !user.delivery_poll_stage) {
    return null;
  }
  if (user.delivery_poll_stage === "manual") {
    return hasConfirmedDelivery(user) ? null : "manual";
  }
  if (user.delivery_poll_stage === "week39_daily") {
    return hasConfirmedDelivery(user) ? null : "week39_daily";
  }
  if (user.delivery_poll_stage === "hpl" && !user.delivery_hpl_response) {
    return "hpl";
  }
  if (user.delivery_poll_stage === "hpl3" && !user.delivery_hpl3_response) {
    return "hpl3";
  }
  return null;
}

function buildDeliveryValidationMessage(user, now, stage) {
  const greeting = getTimeGreeting(now);
  const name = getDisplayName(user);
  if (stage === "manual") {
    return `${greeting}, ${name}.\nKami ingin memastikan apakah Ibu sudah melahirkan ya.`;
  }
  if (stage === "week39_daily") {
    const week = getGestationalWeek(user, now);
    const weekLabel = week ? `minggu ke-${week}` : "masa akhir kehamilan";
    return `${greeting}, ${name}.\nMemasuki ${weekLabel}, kami ingin memastikan apakah Ibu sudah melahirkan ya.`;
  }
  const hpl = getHplDate(user);
  const hplText = hpl ? formatDateId(hpl) : "-";
  if (stage === "hpl3") {
    return `${greeting}, ${name}.\nHari ini adalah H+3 dari HPL (${hplText}). Kami ingin memastikan kondisi Ibu ya.`;
  }
  return `${greeting}, ${name}.\nHari ini adalah HPL (${hplText}). Kami ingin memastikan kondisi Ibu ya.`;
}

function buildDeliveryValidationQuestion() {
  return DELIVERY_VALIDATION_POLL_QUESTION;
}

function parseDeliveryValidationAnswer(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (
    normalized.includes("sudah melahir") ||
    normalized.includes("udah melahir")
  ) {
    return "Sudah";
  }
  if (normalized.includes("belum melahir")) {
    return "Belum";
  }
  return null;
}

function getDeliveryDateTime(user) {
  if (!user || !user.delivery_date_iso || !user.delivery_time) {
    return null;
  }
  const parsed = DateTime.fromISO(
    `${String(user.delivery_date_iso).trim()}T${String(user.delivery_time).trim()}`,
    { zone: TIMEZONE },
  );
  if (!parsed.isValid) {
    return null;
  }
  return parsed;
}

function validateDeliveryDateIso(deliveryDateIso, user, now = nowWib()) {
  if (!deliveryDateIso) {
    return { valid: false, message: "Tanggal melahirkan belum valid." };
  }
  const deliveryDate = DateTime.fromISO(String(deliveryDateIso), {
    zone: TIMEZONE,
  }).startOf("day");
  if (!deliveryDate.isValid) {
    return { valid: false, message: "Tanggal melahirkan belum valid." };
  }
  if (deliveryDate > now.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal melahirkan tidak boleh lebih dari hari ini.",
    };
  }
  const hpht = getHphtDate(user);
  if (hpht && deliveryDate < hpht.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal melahirkan tidak boleh sebelum tanggal HPHT.",
    };
  }
  return { valid: true, message: "" };
}

function validateDeliveryDateTime(
  user,
  deliveryDateIso,
  deliveryTime,
  now = nowWib(),
) {
  if (!deliveryDateIso || !deliveryTime) {
    return { valid: false, message: "Tanggal/jam melahirkan belum lengkap." };
  }
  const deliveryAt = getDeliveryDateTime({
    delivery_date_iso: deliveryDateIso,
    delivery_time: deliveryTime,
  });
  if (!deliveryAt) {
    return {
      valid: false,
      message: "Tanggal atau jam melahirkan belum valid.",
    };
  }
  const baseDateCheck = validateDeliveryDateIso(deliveryDateIso, user, now);
  if (!baseDateCheck.valid) {
    return baseDateCheck;
  }
  if (deliveryAt > now.plus({ minutes: 10 })) {
    return {
      valid: false,
      message: "Jam melahirkan tidak boleh di masa depan.",
    };
  }
  const hpht = getHphtDate(user);
  if (hpht && deliveryAt < hpht.startOf("day")) {
    return {
      valid: false,
      message: "Tanggal/jam melahirkan tidak boleh sebelum HPHT.",
    };
  }
  return { valid: true, message: "" };
}

function hasConfirmedDelivery(user) {
  if (!user) {
    return false;
  }
  const hplResponse = String(user.delivery_hpl_response || "")
    .trim()
    .toLowerCase();
  const hpl3Response = String(user.delivery_hpl3_response || "")
    .trim()
    .toLowerCase();
  if (hplResponse === "sudah" || hpl3Response === "sudah") {
    return true;
  }
  if (user.delivery_data_completed_at) {
    return true;
  }
  const deliveryStep = Number(user.delivery_data_step || 0);
  return Number.isFinite(deliveryStep) && deliveryStep > 0;
}

function isPostpartumMonitoringActive(user) {
  return Boolean(
    user &&
    user.delivery_data_completed_at &&
    user.delivery_date_iso &&
    user.delivery_time,
  );
}

function getPostpartumDueAt(deliveryAt, visit) {
  if (!deliveryAt || !deliveryAt.isValid || !visit) {
    return null;
  }
  return deliveryAt.plus({ hours: visit.startHours });
}

function buildPostpartumEducationMessage(user, now) {
  const name = getDisplayName(user);
  return `Selamat atas kelahiran buah hati, ${name}. 🤍\nRemindCare akan terus menemani Ibu sampai masa krusial ini selesai.\nMasa nifas dan masa neonatal adalah masa yang sangat penting bagi ibu dan bayi. Pada periode ini, risiko gangguan kesehatan masih tinggi sehingga pemantauan rutin sangat diperlukan untuk memastikan ibu dan bayi dalam kondisi sehat.\nRemindCare akan mengingatkan jadwal kunjungan KF dan KN sesuai waktu yang dianjurkan.\nBaca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`;
}

function buildPostpartumVisitMessage(user, visit) {
  const greeting = getTimeGreeting(nowWib());
  const name = getDisplayName(user);
  const focusText = String(visit.focusText || "").trim();
  const formattedFocus = focusText.replace(/\. Bayi:/, ".\n- Bayi:");
  return `${greeting}, ${name}. 👩‍🍼\nPengingat kunjungan ${visit.label} (${visit.kind}). 📅\nRentang waktu: ${visit.windowText}.\nFokus kunjungan:\n- ${formattedFocus}\nYuk periksa ke tenaga kesehatan/fasilitas kesehatan ya. 🏥\nBaca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`;
}

function buildPostpartumVisitQuestion(visit) {
  return `Apakah Ibu sudah melakukan kunjungan ${visit.label}?`;
}

function sendText(client, chatId, text) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  if (isUnsupportedDirectTarget(chatId)) {
    console.warn("Lewati kirim pesan ke target non-user:", chatId);
    return null;
  }
  return resolved
    .sendMessage(chatId, text, { sendSeen: false })
    .catch((err) => {
      console.error("Gagal mengirim pesan ke", chatId, ":", err);
      return null;
    });
}

function sendPoll(client, chatId, poll) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  if (isUnsupportedDirectTarget(chatId)) {
    console.warn("Lewati kirim polling ke target non-user:", chatId);
    return null;
  }
  return resolved
    .sendMessage(chatId, poll, { sendSeen: false })
    .catch((err) => {
      console.error("Gagal mengirim polling ke", chatId, ":", err);
      return null;
    });
}

function nowWib() {
  return DateTime.now().setZone(TIMEZONE);
}

function toDateKey(dt) {
  return dt.toFormat("yyyy-LL-dd");
}

function getRetryDelayMs(failCount) {
  const base =
    Number.isFinite(POLL_RETRY_BASE_DELAY_MS) && POLL_RETRY_BASE_DELAY_MS > 0
      ? POLL_RETRY_BASE_DELAY_MS
      : 5 * 60 * 1000;
  const capped =
    Number.isFinite(POLL_RETRY_MAX_DELAY_MS) && POLL_RETRY_MAX_DELAY_MS > 0
      ? POLL_RETRY_MAX_DELAY_MS
      : 30 * 60 * 1000;
  const safeFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) > 0
      ? Number(failCount)
      : 0;
  if (safeFailCount <= 0) {
    return 0;
  }
  const delay = base * 2 ** (safeFailCount - 1);
  return delay > capped ? capped : delay;
}

function canAttemptByBackoff(lastAttemptAt, failCount, now = nowWib()) {
  const safeFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) > 0
      ? Number(failCount)
      : 0;
  if (safeFailCount <= 0) {
    return true;
  }
  if (!lastAttemptAt) {
    return true;
  }
  const attemptedAt = DateTime.fromISO(String(lastAttemptAt), {
    zone: TIMEZONE,
  });
  if (!attemptedAt.isValid) {
    return true;
  }
  const delayMs = getRetryDelayMs(safeFailCount);
  return now.toMillis() - attemptedAt.toMillis() >= delayMs;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getAdminPasswordConfig() {
  ensureDataDir();
  if (ADMIN_WEB_PASSWORD) {
    return { password: ADMIN_WEB_PASSWORD, source: "env", filePath: null };
  }
  const passwordFile = path.join(DATA_DIR, "admin_web_password.txt");
  if (fs.existsSync(passwordFile)) {
    const stored = fs.readFileSync(passwordFile, "utf8").trim();
    if (stored) {
      return { password: stored, source: "file", filePath: passwordFile };
    }
  }
  const randomPart = crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/[+/=]/g, "");
  const generated = `Rc-${randomPart}`;
  fs.writeFileSync(passwordFile, generated, "utf8");
  return { password: generated, source: "generated", filePath: passwordFile };
}

function parseCookies(header) {
  const cookies = {};
  if (!header) {
    return cookies;
  }
  const parts = header.split(";");
  for (const part of parts) {
    const [rawKey, ...rawValue] = part.split("=");
    if (!rawKey) {
      continue;
    }
    const key = rawKey.trim();
    const value = rawValue.join("=").trim();
    if (!key) {
      continue;
    }
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isPasswordMatch(input, expected) {
  if (!input || !expected) {
    return false;
  }
  const inputBuffer = Buffer.from(String(input));
  const expectedBuffer = Buffer.from(String(expected));
  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}

function createAdminSession() {
  const token = crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "");
  const ttl =
    Number.isFinite(ADMIN_WEB_SESSION_TTL_MS) && ADMIN_WEB_SESSION_TTL_MS > 0
      ? ADMIN_WEB_SESSION_TTL_MS
      : 8 * 60 * 60 * 1000;
  adminSessions.set(token, { expiresAt: Date.now() + ttl });
  return token;
}

function getAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.rc_admin;
  if (!token) {
    return null;
  }
  const session = adminSessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt && Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return token;
}

function setAdminCookie(res, token) {
  const ttlMs =
    Number.isFinite(ADMIN_WEB_SESSION_TTL_MS) && ADMIN_WEB_SESSION_TTL_MS > 0
      ? ADMIN_WEB_SESSION_TTL_MS
      : 8 * 60 * 60 * 1000;
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  const expires = new Date(Date.now() + ttlMs).toUTCString();
  const parts = [
    `rc_admin=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${expires}`,
  ];
  if (ADMIN_WEB_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res) {
  const parts = [
    "rc_admin=",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (ADMIN_WEB_COOKIE_SECURE) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAdminLoginPage(message) {
  const alert = message
    ? `<div class="alert">${escapeHtml(message)}</div>`
    : "";
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #f7f7f7;
        --panel: #ffffff;
        --text: #111111;
        --muted: #666666;
        --border: #e3e3e3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Lato", sans-serif;
        background: radial-gradient(circle at top, #ffffff 0%, #f2f2f2 60%, #ededed 100%);
        color: var(--text);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 18px 45px rgba(0,0,0,0.08);
        padding: 32px;
        display: grid;
        gap: 16px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
      }
      .sub {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }
      form {
        display: grid;
        gap: 14px;
      }
      label {
        font-size: 13px;
        color: var(--muted);
        display: grid;
        gap: 6px;
      }
      input {
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid var(--border);
        font-size: 15px;
        font-family: inherit;
        background: #fff;
      }
      button {
        padding: 12px 16px;
        border-radius: 999px;
        border: none;
        background: #111;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        transition: transform 0.2s ease;
      }
      button:hover {
        transform: translateY(-1px);
      }
      .alert {
        background: #111;
        color: #fff;
        padding: 12px 14px;
        border-radius: 10px;
        font-size: 13px;
        animation: slideIn 0.35s ease;
      }
      @keyframes slideIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div>
        <h1>RemindCare Admin</h1>
        <p class="sub">Masuk untuk akses dashboard</p>
      </div>
      ${alert}
      <form method="post" action="/admin/login">
        <label>Username (opsional)
          <input name="username" placeholder="admin">
        </label>
        <label>Password
          <input type="password" name="password" placeholder="Password" required>
        </label>
        <button type="submit">Masuk</button>
      </form>
    </div>
  </body>
</html>`;
}

function renderAdminDashboardPage() {
  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RemindCare Admin</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
    <style>
      :root {
        --bg: #f7f7f7;
        --panel: #ffffff;
        --text: #0f0f0f;
        --muted: #666666;
        --border: #e3e3e3;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Lato", sans-serif;
        background: linear-gradient(180deg, #ffffff 0%, #f4f4f4 100%);
        color: var(--text);
      }
      header {
        padding: 28px 28px 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
      }
      .subtitle {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button, .ghost {
        padding: 10px 16px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: #111;
        color: #fff;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        font-size: 13px;
        transition: transform 0.2s ease;
      }
      .ghost {
        background: #fff;
        color: #111;
      }
      button:hover, .ghost:hover {
        transform: translateY(-1px);
      }
      main {
        padding: 0 28px 40px;
        display: grid;
        gap: 24px;
      }
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 14px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 16px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.06);
      }
      .card .label {
        font-size: 12px;
        color: var(--muted);
      }
      .card .value {
        font-size: 22px;
        font-weight: 700;
        margin-top: 8px;
      }
      .section-title {
        font-size: 15px;
        font-weight: 700;
        margin-bottom: 12px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 14px;
        overflow: hidden;
        font-size: 13px;
      }
      th, td {
        text-align: left;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
      }
      th {
        background: #f2f2f2;
        font-weight: 700;
      }
      tbody tr:hover {
        background: #fafafa;
      }
      tbody tr.row-clickable {
        cursor: pointer;
      }
      tbody tr.row-clickable:hover {
        background: #f3f3f3;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
      .grid {
        display: grid;
        gap: 14px;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 15, 15, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }
      .overlay.show {
        opacity: 1;
        pointer-events: auto;
      }
      .modal {
        width: min(920px, 96vw);
        max-height: 90vh;
        overflow: hidden;
        background: #fff;
        border-radius: 18px;
        border: 1px solid var(--border);
        box-shadow: 0 18px 50px rgba(0,0,0,0.18);
        display: grid;
        grid-template-rows: auto 1fr;
        transform: translateY(10px);
        transition: transform 0.2s ease;
      }
      .overlay.show .modal {
        transform: translateY(0);
      }
      .modal-header {
        padding: 18px 20px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .modal-actions {
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .modal-title {
        font-size: 18px;
        font-weight: 700;
      }
      .modal-body {
        padding: 18px 20px 22px;
        overflow: auto;
        display: grid;
        gap: 16px;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
      }
      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #111;
        color: #fff;
        padding: 12px 16px;
        border-radius: 12px;
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      @media (max-width: 720px) {
        header, main { padding: 20px; }
        table { font-size: 12px; }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>RemindCare Admin</h1>
        <div class="subtitle">Dashboard ringkas pengguna dan pengingat</div>
        <div class="muted">Terakhir diperbarui: <span id="last-updated">-</span></div>
      </div>
      <div class="actions">
        <button id="refresh-btn">Refresh</button>
        <a class="ghost" href="/admin/api/export/users.csv">Download Users CSV</a>
        <a class="ghost" href="/admin/api/export/reminder_logs.csv">Download Logs CSV</a>
        <a class="ghost" href="/admin/api/export/postpartum_logs.csv">Download Postpartum CSV</a>
        <form method="post" action="/admin/logout">
          <button type="submit" class="ghost">Logout</button>
        </form>
      </div>
    </header>
    <main>
      <section class="stats">
        <div class="card"><div class="label">Total Users</div><div class="value" id="stat-users-total">-</div></div>
        <div class="card"><div class="label">Aktif</div><div class="value" id="stat-users-active">-</div></div>
        <div class="card"><div class="label">Paused</div><div class="value" id="stat-users-paused">-</div></div>
        <div class="card"><div class="label">Selesai</div><div class="value" id="stat-users-completed">-</div></div>
        <div class="card"><div class="label">Sudah (hari ini)</div><div class="value" id="stat-today-sudah">-</div></div>
        <div class="card"><div class="label">Belum (hari ini)</div><div class="value" id="stat-today-belum">-</div></div>
      </section>

      <section class="grid">
        <div class="section-title">Daftar Users</div>
        <table>
          <thead>
            <tr>
              <th>WA ID</th>
              <th>Nama</th>
              <th>Status</th>
              <th>Jam</th>
              <th>Respon Terakhir</th>
              <th>Jawaban Terakhir</th>
              <th>Total Sudah</th>
              <th>Total Belum</th>
            </tr>
          </thead>
          <tbody id="users-body">
            <tr><td colspan="8" class="muted">Loading...</td></tr>
          </tbody>
        </table>
      </section>

      <section class="grid">
        <div class="section-title">Log Terbaru</div>
        <table>
          <thead>
            <tr>
              <th>Tanggal</th>
              <th>WA ID</th>
              <th>Jawaban</th>
              <th>Sudah Count</th>
              <th>Belum Count</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody id="logs-body">
            <tr><td colspan="6" class="muted">Loading...</td></tr>
          </tbody>
        </table>
      </section>
    </main>

    <div class="overlay" id="user-overlay">
      <div class="modal">
        <div class="modal-header">
          <div>
            <div class="modal-title" id="detail-name">Detail User</div>
            <div class="muted" id="detail-wa">-</div>
          </div>
          <div class="modal-actions">
            <a class="ghost" id="detail-export" href="#" target="_blank" rel="noopener">Download CSV</a>
            <button class="ghost" id="detail-close">Tutup</button>
          </div>
        </div>
        <div class="modal-body">
          <div class="detail-grid" id="detail-stats">
            <div class="card"><div class="label">Status</div><div class="value" id="detail-status">-</div></div>
            <div class="card"><div class="label">Jam Pengingat</div><div class="value" id="detail-time">-</div></div>
            <div class="card"><div class="label">Total Sudah</div><div class="value" id="detail-total-sudah">-</div></div>
            <div class="card"><div class="label">Total Belum</div><div class="value" id="detail-total-belum">-</div></div>
          </div>
          <div class="section-title">Data Persalinan</div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Nilai</th>
              </tr>
            </thead>
            <tbody id="detail-delivery-body">
              <tr><td colspan="2" class="muted">Belum ada data persalinan.</td></tr>
            </tbody>
          </table>
          <div class="section-title">History Kunjungan Nifas & Bayi</div>
          <table>
            <thead>
              <tr>
                <th>Kunjungan</th>
                <th>Status</th>
                <th>Tanggal Konfirmasi</th>
              </tr>
            </thead>
            <tbody id="detail-postpartum-body">
              <tr><td colspan="3" class="muted">Belum ada history konfirmasi kunjungan.</td></tr>
            </tbody>
          </table>
          <div class="section-title">History Reminder</div>
          <table>
            <thead>
              <tr>
                <th>Tanggal</th>
                <th>Jawaban</th>
                <th>Sudah Count</th>
                <th>Belum Count</th>
                <th>Created At</th>
              </tr>
            </thead>
            <tbody id="detail-logs-body">
              <tr><td colspan="5" class="muted">Pilih user untuk melihat detail.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="toast" id="toast"></div>

    <script>
      const toast = document.getElementById('toast');
      function showToast(message) {
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(window.__toastTimer);
        window.__toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
      }
      function fmt(value) {
        return value === null || value === undefined || value === '' ? '-' : value;
      }
      async function fetchJson(url) {
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) {
          throw new Error('Gagal memuat data');
        }
        return res.json();
      }
      async function loadSummary() {
        const data = await fetchJson('/admin/api/summary');
        document.getElementById('stat-users-total').textContent = fmt(data.users.total);
        document.getElementById('stat-users-active').textContent = fmt(data.users.active);
        document.getElementById('stat-users-paused').textContent = fmt(data.users.paused);
        document.getElementById('stat-users-completed').textContent = fmt(data.users.completed);
        document.getElementById('stat-today-sudah').textContent = fmt(data.reminders.todaySudah);
        document.getElementById('stat-today-belum').textContent = fmt(data.reminders.todayBelum);
      }
      async function loadUsers() {
        const data = await fetchJson('/admin/api/users');
        const tbody = document.getElementById('users-body');
        tbody.innerHTML = '';
        if (!data.users.length) {
          tbody.innerHTML = '<tr><td colspan="8" class="muted">Belum ada user.</td></tr>';
          return;
        }
        for (const user of data.users) {
          const tr = document.createElement('tr');
          tr.classList.add('row-clickable');
          tr.dataset.waId = user.wa_id;
          tr.addEventListener('click', () => openUserDetail(user.wa_id));
          const cells = [
            user.wa_id,
            user.name,
            user.status,
            user.reminder_time,
            user.last_response_date,
            user.last_response,
            user.total_sudah,
            user.total_belum
          ];
          for (const value of cells) {
            const td = document.createElement('td');
            td.textContent = fmt(value);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }
      const overlay = document.getElementById('user-overlay');
      const closeBtn = document.getElementById('detail-close');
      function closeUserDetail() {
        overlay.classList.remove('show');
      }
      closeBtn.addEventListener('click', closeUserDetail);
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          closeUserDetail();
        }
      });
      function renderDeliveryDetails(user) {
        const tbody = document.getElementById('detail-delivery-body');
        const rows = [
          ['Validasi HPL', user.delivery_hpl_response],
          ['Validasi HPL +3', user.delivery_hpl3_response],
          ['Tanggal melahirkan', user.delivery_date_iso || user.delivery_date],
          ['Jam melahirkan', user.delivery_time],
          ['Tempat melahirkan', user.delivery_place],
          ['Penolong persalinan', user.delivery_birth_attendant],
          ['Penyulit persalinan', user.delivery_with_complication],
          ['Jenis kelamin bayi', user.baby_gender],
          ['Berat badan bayi', user.baby_birth_weight],
          ['Keluhan ibu saat ini', user.mother_current_complaint],
          ['Data selesai diisi', user.delivery_data_completed_at]
        ];
        const hasData = rows.some((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
        if (!hasData) {
          tbody.innerHTML = '<tr><td colspan="2" class="muted">Belum ada data persalinan.</td></tr>';
          return;
        }
        tbody.innerHTML = '';
        for (const row of rows) {
          const tr = document.createElement('tr');
          const tdLabel = document.createElement('td');
          tdLabel.textContent = row[0];
          const tdValue = document.createElement('td');
          tdValue.textContent = fmt(row[1]);
          tr.appendChild(tdLabel);
          tr.appendChild(tdValue);
          tbody.appendChild(tr);
        }
      }
      function renderPostpartumLogs(logs) {
        const tbody = document.getElementById('detail-postpartum-body');
        const confirmedLogs = (logs || []).filter((log) => log.response === 'Sudah');
        if (!confirmedLogs.length) {
          tbody.innerHTML = '<tr><td colspan="3" class="muted">Belum ada konfirmasi kunjungan (Sudah).</td></tr>';
          return;
        }
        tbody.innerHTML = '';
        for (const log of confirmedLogs) {
          const tr = document.createElement('tr');
          const cells = [
            log.visit_label || log.visit_code,
            'Sudah ✅',
            log.response_at
          ];
          for (const value of cells) {
            const td = document.createElement('td');
            td.textContent = fmt(value);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }
      async function openUserDetail(waId) {
        overlay.classList.add('show');
        document.getElementById('detail-name').textContent = 'Detail User';
        document.getElementById('detail-wa').textContent = fmt(waId);
        document.getElementById('detail-export').setAttribute(
          'href',
          '/admin/api/users/' + encodeURIComponent(waId) + '/export.csv'
        );
        document.getElementById('detail-status').textContent = '-';
        document.getElementById('detail-time').textContent = '-';
        document.getElementById('detail-total-sudah').textContent = '-';
        document.getElementById('detail-total-belum').textContent = '-';
        const deliveryBody = document.getElementById('detail-delivery-body');
        deliveryBody.innerHTML = '<tr><td colspan="2" class="muted">Memuat data...</td></tr>';
        const postpartumBody = document.getElementById('detail-postpartum-body');
        postpartumBody.innerHTML = '<tr><td colspan="3" class="muted">Memuat data...</td></tr>';
        const detailBody = document.getElementById('detail-logs-body');
        detailBody.innerHTML = '<tr><td colspan="5" class="muted">Memuat data...</td></tr>';
        try {
          const data = await fetchJson('/admin/api/users/' + encodeURIComponent(waId));
          const user = data.user || {};
          document.getElementById('detail-name').textContent = fmt(user.name || 'Detail User');
          document.getElementById('detail-wa').textContent = fmt(user.wa_id);
          document.getElementById('detail-status').textContent = fmt(user.status);
          document.getElementById('detail-time').textContent = fmt(user.reminder_time);
          document.getElementById('detail-total-sudah').textContent = fmt(data.totals.total_sudah);
          document.getElementById('detail-total-belum').textContent = fmt(data.totals.total_belum);
          renderDeliveryDetails(user);
          renderPostpartumLogs(data.postpartum_logs || []);
          detailBody.innerHTML = '';
          if (!data.logs.length) {
            detailBody.innerHTML = '<tr><td colspan="5" class="muted">Belum ada history.</td></tr>';
            return;
          }
          for (const log of data.logs) {
            const tr = document.createElement('tr');
            const cells = [
              log.reminder_date,
              log.response,
              log.response_sudah_count,
              log.response_belum_count,
              log.created_at
            ];
            for (const value of cells) {
              const td = document.createElement('td');
              td.textContent = fmt(value);
              tr.appendChild(td);
            }
            detailBody.appendChild(tr);
          }
        } catch (err) {
          deliveryBody.innerHTML = '<tr><td colspan="2" class="muted">Gagal memuat data persalinan.</td></tr>';
          postpartumBody.innerHTML = '<tr><td colspan="3" class="muted">Gagal memuat history kunjungan.</td></tr>';
          detailBody.innerHTML = '<tr><td colspan="5" class="muted">Gagal memuat detail.</td></tr>';
        }
      }
      async function loadLogs() {
        const data = await fetchJson('/admin/api/logs');
        const tbody = document.getElementById('logs-body');
        tbody.innerHTML = '';
        if (!data.logs.length) {
          tbody.innerHTML = '<tr><td colspan="6" class="muted">Belum ada log.</td></tr>';
          return;
        }
        for (const log of data.logs) {
          const tr = document.createElement('tr');
          const cells = [
            log.reminder_date,
            log.wa_id,
            log.response,
            log.response_sudah_count,
            log.response_belum_count,
            log.created_at
          ];
          for (const value of cells) {
            const td = document.createElement('td');
            td.textContent = fmt(value);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }
      async function loadAll() {
        try {
          await Promise.all([loadSummary(), loadUsers(), loadLogs()]);
          document.getElementById('last-updated').textContent = new Date().toLocaleString('id-ID');
        } catch (err) {
          showToast(err.message || 'Gagal memuat data');
        }
      }
      document.getElementById('refresh-btn').addEventListener('click', () => loadAll());
      loadAll();
    </script>
  </body>
</html>`;
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
  await ensureColumn(
    db,
    "users",
    "is_admin",
    "is_admin INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "is_allowed",
    "is_allowed INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "is_blocked",
    "is_blocked INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "last_labor_phase_message_date",
    "last_labor_phase_message_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "last_reminder_text_date",
    "last_reminder_text_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "last_delivery_poll_message_id",
    "last_delivery_poll_message_id TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_stage",
    "delivery_poll_stage TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "fe_poll_last_attempt_at",
    "fe_poll_last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "fe_poll_fail_count",
    "fe_poll_fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_last_attempt_at",
    "delivery_poll_last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_fail_count",
    "delivery_poll_fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_intro_stage",
    "delivery_poll_intro_stage TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_poll_intro_date",
    "delivery_poll_intro_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_poll_sent_date",
    "delivery_hpl_poll_sent_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_response",
    "delivery_hpl_response TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl_response_at",
    "delivery_hpl_response_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_poll_sent_date",
    "delivery_hpl3_poll_sent_date TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_response",
    "delivery_hpl3_response TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_hpl3_response_at",
    "delivery_hpl3_response_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_data_step",
    "delivery_data_step INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(db, "users", "delivery_date", "delivery_date TEXT");
  await ensureColumn(
    db,
    "users",
    "delivery_date_iso",
    "delivery_date_iso TEXT",
  );
  await ensureColumn(db, "users", "delivery_time", "delivery_time TEXT");
  await ensureColumn(db, "users", "delivery_place", "delivery_place TEXT");
  await ensureColumn(
    db,
    "users",
    "delivery_birth_attendant",
    "delivery_birth_attendant TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_with_complication",
    "delivery_with_complication TEXT",
  );
  await ensureColumn(db, "users", "baby_gender", "baby_gender TEXT");
  await ensureColumn(
    db,
    "users",
    "baby_birth_weight",
    "baby_birth_weight TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "mother_current_complaint",
    "mother_current_complaint TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "delivery_data_completed_at",
    "delivery_data_completed_at TEXT",
  );
  await ensureColumn(
    db,
    "users",
    "postpartum_education_sent_at",
    "postpartum_education_sent_at TEXT",
  );
}

async function ensureReminderLogColumns(db) {
  await ensureColumn(
    db,
    "reminder_logs",
    "response_count",
    "response_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "reminder_logs",
    "response_sudah_count",
    "response_sudah_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "reminder_logs",
    "response_belum_count",
    "response_belum_count INTEGER NOT NULL DEFAULT 0",
  );
}

async function ensurePostpartumLogColumns(db) {
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "reminder_text_sent_at",
    "reminder_text_sent_at TEXT",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "last_attempt_at",
    "last_attempt_at TEXT",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "fail_count",
    "fail_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_count",
    "response_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_sudah_count",
    "response_sudah_count INTEGER NOT NULL DEFAULT 0",
  );
  await ensureColumn(
    db,
    "postpartum_visit_logs",
    "response_belum_count",
    "response_belum_count INTEGER NOT NULL DEFAULT 0",
  );
}

function pickIsoMin(values) {
  const filtered = (values || []).filter(Boolean).sort();
  return filtered.length > 0 ? filtered[0] : null;
}

function pickIsoMax(values) {
  const filtered = (values || []).filter(Boolean).sort();
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

function scoreLegacyPostpartumLog(log) {
  if (!log) {
    return 0;
  }
  if (log.response === "Sudah") {
    return 100;
  }
  if (log.response === "Belum") {
    return 80;
  }
  if (log.poll_message_id) {
    return 50;
  }
  if (log.sent_at) {
    return 40;
  }
  if (log.reminder_text_sent_at) {
    return 30;
  }
  return 10;
}

function buildMergedLegacyPostpartumLogRows(waId, visit, legacyLogs) {
  const rows = Array.isArray(legacyLogs) ? legacyLogs.filter(Boolean) : [];
  if (!waId || !visit || rows.length === 0) {
    return null;
  }

  const ranked = [...rows].sort((a, b) => {
    const scoreDiff = scoreLegacyPostpartumLog(b) - scoreLegacyPostpartumLog(a);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  const base = ranked[0];
  if (!base) {
    return null;
  }

  const nowIso = nowWib().toISO();
  const response = rows.some((item) => item.response === "Sudah")
    ? "Sudah"
    : rows.some((item) => item.response === "Belum")
      ? "Belum"
      : null;
  const responseRows = rows.filter((item) => item.response === response);
  const pollSource = [...rows]
    .filter((item) => item.poll_message_id)
    .sort((a, b) => String(b.sent_at || "").localeCompare(String(a.sent_at || "")))[0];

  const responseCount = rows.reduce((total, item) => {
    const count = Number(item.response_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);
  const responseSudahCount = rows.reduce((total, item) => {
    const count = Number(item.response_sudah_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);
  const responseBelumCount = rows.reduce((total, item) => {
    const count = Number(item.response_belum_count || 0);
    return Number.isFinite(count) && count > 0 ? total + count : total;
  }, 0);

  return {
    wa_id: waId,
    visit_code: visit.code,
    visit_kind: visit.kind,
    visit_label: visit.label,
    window_text: visit.windowText,
    benefit_text: visit.focusText,
    due_at: pickIsoMin(rows.map((item) => item.due_at)) || nowIso,
    reminder_text_sent_at: pickIsoMin(rows.map((item) => item.reminder_text_sent_at)),
    sent_at: pickIsoMin(rows.map((item) => item.sent_at)),
    poll_message_id: pollSource ? pollSource.poll_message_id : null,
    last_attempt_at: pickIsoMax(rows.map((item) => item.last_attempt_at)),
    fail_count: Math.max(
      0,
      ...rows.map((item) => {
        const count = Number(item.fail_count || 0);
        return Number.isFinite(count) && count >= 0 ? count : 0;
      }),
    ),
    response,
    response_count: responseCount,
    response_sudah_count: responseSudahCount,
    response_belum_count: responseBelumCount,
    response_at:
      responseRows.length > 0
        ? pickIsoMax(responseRows.map((item) => item.response_at))
        : null,
    created_at: pickIsoMin(rows.map((item) => item.created_at)) || nowIso,
    updated_at: pickIsoMax(rows.map((item) => item.updated_at)) || nowIso,
  };
}

async function migrateLegacyPostpartumVisitLogs(db) {
  const legacyCodes = LEGACY_POSTPARTUM_VISIT_GROUPS.flatMap(
    (item) => item.legacyCodes,
  );
  if (legacyCodes.length === 0) {
    return;
  }

  const placeholders = legacyCodes.map(() => "?").join(", ");
  const legacyRows = await dbAll(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE visit_code IN (${placeholders})
     ORDER BY wa_id ASC, id ASC`,
    legacyCodes,
  );
  if (!legacyRows || legacyRows.length === 0) {
    return;
  }

  const rowsByUser = new Map();
  for (const row of legacyRows) {
    if (!rowsByUser.has(row.wa_id)) {
      rowsByUser.set(row.wa_id, []);
    }
    rowsByUser.get(row.wa_id).push(row);
  }

  for (const [waId, rows] of rowsByUser.entries()) {
    for (const group of LEGACY_POSTPARTUM_VISIT_GROUPS) {
      const visit = POSTPARTUM_VISIT_BY_CODE.get(group.code);
      if (!visit) {
        continue;
      }
      const relatedLegacy = rows.filter((row) =>
        group.legacyCodes.includes(row.visit_code),
      );
      if (relatedLegacy.length === 0) {
        continue;
      }

      const existingGrouped = await dbGet(
        db,
        `SELECT id FROM postpartum_visit_logs WHERE wa_id = ? AND visit_code = ?`,
        [waId, group.code],
      );
      if (!existingGrouped) {
        const merged = buildMergedLegacyPostpartumLogRows(
          waId,
          visit,
          relatedLegacy,
        );
        if (merged) {
          await dbRun(
            db,
            `INSERT INTO postpartum_visit_logs (
              wa_id,
              visit_code,
              visit_kind,
              visit_label,
              window_text,
              benefit_text,
              due_at,
              reminder_text_sent_at,
              sent_at,
              poll_message_id,
              last_attempt_at,
              fail_count,
              response,
              response_count,
              response_sudah_count,
              response_belum_count,
              response_at,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              merged.wa_id,
              merged.visit_code,
              merged.visit_kind,
              merged.visit_label,
              merged.window_text,
              merged.benefit_text,
              merged.due_at,
              merged.reminder_text_sent_at,
              merged.sent_at,
              merged.poll_message_id,
              merged.last_attempt_at,
              merged.fail_count,
              merged.response,
              merged.response_count,
              merged.response_sudah_count,
              merged.response_belum_count,
              merged.response_at,
              merged.created_at,
              merged.updated_at,
            ],
          );
        }
      }

      const legacyPlaceholders = group.legacyCodes.map(() => "?").join(", ");
      await dbRun(
        db,
        `DELETE FROM postpartum_visit_logs
         WHERE wa_id = ? AND visit_code IN (${legacyPlaceholders})`,
        [waId, ...group.legacyCodes],
      );
    }
  }
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );

  await dbRun(
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

  await dbRun(
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

  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_users_active_loop
     ON users (status, allow_remindcare, is_blocked, reminder_time, last_reminder_date)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_postpartum_logs_wa_due
     ON postpartum_visit_logs (wa_id, due_at, sent_at, response)`,
  );
  await dbRun(
    db,
    `CREATE INDEX IF NOT EXISTS idx_postpartum_logs_poll
     ON postpartum_visit_logs (wa_id, poll_message_id)`,
  );

  await ensureUserColumns(db);
  await ensureReminderLogColumns(db);
  await ensurePostpartumLogColumns(db);
  await migrateLegacyPostpartumVisitLogs(db);
}

async function getUser(db, waId) {
  return dbGet(db, "SELECT * FROM users WHERE wa_id = ?", [waId]);
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
    [waId, isAdmin, isAllowed, isBlocked, nowIso, nowIso],
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
  const setClause = keys.map((key) => `${key} = ?`).join(", ");
  const params = keys.map((key) => updates[key]);
  params.push(nowIso, waId);

  await dbRun(
    db,
    `UPDATE users SET ${setClause}, updated_at = ? WHERE wa_id = ?`,
    params,
  );
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
  const cleaned = raw.replace(/\s+/g, "").replace(".", ":");

  let hour;
  let minute;

  if (/^\d{1,2}$/.test(cleaned)) {
    hour = Number(cleaned);
    minute = 0;
  } else if (/^\d{1,2}:\d{1,2}$/.test(cleaned)) {
    const parts = cleaned.split(":");
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

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeBirthWeightGram(input) {
  if (!input) {
    return null;
  }
  const raw = String(input).trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (/\b(kg|kilogram|kilo)\b/.test(raw)) {
    return null;
  }
  const match = raw.match(/(\d[\d.,]*)/);
  if (!match || !match[1]) {
    return null;
  }
  const gramsText = match[1].replace(/\D/g, "");
  if (!gramsText) {
    return null;
  }
  const grams = Number(gramsText);
  if (!Number.isFinite(grams) || grams <= 0) {
    return null;
  }
  return `${Math.round(grams)} gram`;
}

function parseHpht(input) {
  const raw = input ? input.trim() : "";
  if (!raw) {
    return { raw: "", iso: null };
  }

  const patterns = [
    { regex: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/, order: "ymd" },
    { regex: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, order: "dmy" },
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern.regex);
    if (!match) {
      continue;
    }

    let year;
    let month;
    let day;

    if (pattern.order === "ymd") {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    }

    const parsed = DateTime.fromObject(
      { year, month, day },
      { zone: TIMEZONE },
    );
    if (parsed.isValid) {
      return { raw, iso: parsed.toFormat("yyyy-LL-dd") };
    }
  }

  return { raw, iso: null };
}

function parsePollAnswer(input) {
  if (!input) {
    return null;
  }
  const normalized = input.trim().toLowerCase();
  if (normalized.includes("sudah") || normalized.includes("udah")) {
    return "Sudah";
  }
  if (normalized.includes("belum")) {
    return "Belum";
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
  const rest = (match[1] || "").trim();
  if (!rest) {
    return { action: "help", args: [], rawArgs: "" };
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
  const cutoff = now.minus({ days: retentionDays }).toFormat("yyyy-LL-dd");
  const result = await dbRun(
    db,
    "DELETE FROM reminder_logs WHERE reminder_date < ?",
    [cutoff],
  );
  return result && typeof result.changes === "number" ? result.changes : 0;
}

async function getUserStats(db) {
  const total = await dbGet(db, "SELECT COUNT(*) as count FROM users");
  const active = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'active'",
  );
  const allowed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_allowed = 1",
  );
  const blocked = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_blocked = 1",
  );
  return {
    total: total ? total.count : 0,
    active: active ? active.count : 0,
    allowed: allowed ? allowed.count : 0,
    blocked: blocked ? blocked.count : 0,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildCsv(rows, columns) {
  const header = columns.map((col) => csvEscape(col.label)).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => csvEscape(row[col.key])).join(","),
  );
  return [header, ...lines].join("\n");
}

function buildPostpartumSnapshot(postpartumLogs) {
  const logs = Array.isArray(postpartumLogs) ? postpartumLogs : [];
  const byCode = new Map(logs.map((item) => [item.visit_code, item]));
  const total = logs.length;
  const sent = logs.filter((item) => item.sent_at).length;
  const sudah = logs.filter((item) => item.response === "Sudah").length;
  const belum = logs.filter((item) => item.response === "Belum").length;
  const pending = logs.filter((item) => item.sent_at && !item.response).length;

  const snapshot = {
    postpartum_total: total,
    postpartum_sent: sent,
    postpartum_sudah: sudah,
    postpartum_belum: belum,
    postpartum_pending: pending,
  };

  const confirmedDates = [];
  for (const visit of POSTPARTUM_VISIT_SCHEDULES) {
    const key = visit.code.toLowerCase();
    const log = byCode.get(visit.code) || null;
    const confirmedAt =
      log && log.response === "Sudah" ? log.response_at || null : null;
    snapshot[`${key}_confirmed_at`] = confirmedAt;
    if (confirmedAt) {
      confirmedDates.push(confirmedAt);
    }
  }
  snapshot.postpartum_last_confirmed_at = pickIsoMax(confirmedDates);

  return snapshot;
}

async function getAdminSummary(db) {
  const total = await dbGet(db, "SELECT COUNT(*) as count FROM users");
  const active = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'active'",
  );
  const paused = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'paused'",
  );
  const completed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE status = 'completed'",
  );
  const allowed = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_allowed = 1",
  );
  const blocked = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM users WHERE is_blocked = 1",
  );
  const today = toDateKey(nowWib());
  const todaySudah = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM reminder_logs WHERE reminder_date = ? AND response = 'Sudah'",
    [today],
  );
  const todayBelum = await dbGet(
    db,
    "SELECT COUNT(*) as count FROM reminder_logs WHERE reminder_date = ? AND response = 'Belum'",
    [today],
  );
  return {
    users: {
      total: total ? total.count : 0,
      active: active ? active.count : 0,
      paused: paused ? paused.count : 0,
      completed: completed ? completed.count : 0,
      allowed: allowed ? allowed.count : 0,
      blocked: blocked ? blocked.count : 0,
    },
    reminders: {
      todaySudah: todaySudah ? todaySudah.count : 0,
      todayBelum: todayBelum ? todayBelum.count : 0,
    },
  };
}

async function getAdminUsers(db) {
  return dbAll(
    db,
    `SELECT
      u.wa_id,
      u.name,
      u.status,
      u.reminder_time,
      u.delivery_hpl_response,
      u.delivery_hpl3_response,
      u.delivery_date_iso,
      u.delivery_time,
      u.delivery_place,
      u.delivery_birth_attendant,
      u.delivery_with_complication,
      u.baby_gender,
      u.baby_birth_weight,
      u.mother_current_complaint,
      u.delivery_data_completed_at,
      COALESCE(pv.postpartum_total, 0) as postpartum_total,
      COALESCE(pv.postpartum_sent, 0) as postpartum_sent,
      COALESCE(pv.postpartum_sudah, 0) as postpartum_sudah,
      COALESCE(pv.postpartum_belum, 0) as postpartum_belum,
      rl_last.reminder_date as last_response_date,
      rl_last.response as last_response,
      COALESCE(agg.total_sudah, 0) as total_sudah,
      COALESCE(agg.total_belum, 0) as total_belum
     FROM users u
     LEFT JOIN (
       SELECT wa_id,
              SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as total_sudah,
              SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as total_belum
       FROM reminder_logs
       GROUP BY wa_id
     ) agg ON agg.wa_id = u.wa_id
     LEFT JOIN (
       SELECT wa_id,
              COUNT(*) as postpartum_total,
              SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as postpartum_sent,
              SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as postpartum_sudah,
              SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as postpartum_belum
       FROM postpartum_visit_logs
       GROUP BY wa_id
     ) pv ON pv.wa_id = u.wa_id
     LEFT JOIN reminder_logs rl_last
       ON rl_last.wa_id = u.wa_id
       AND rl_last.reminder_date = (
         SELECT MAX(reminder_date)
         FROM reminder_logs
         WHERE wa_id = u.wa_id
       )
     ORDER BY u.created_at DESC`,
  );
}

async function deleteUserData(db, waId) {
  await dbRun(db, "DELETE FROM postpartum_visit_logs WHERE wa_id = ?", [waId]);
  await dbRun(db, "DELETE FROM reminder_logs WHERE wa_id = ?", [waId]);
  await dbRun(db, "DELETE FROM users WHERE wa_id = ?", [waId]);
}

function hasAnyDeliveryRecord(user) {
  if (!user) {
    return false;
  }
  const step = Number(user.delivery_data_step || 0);
  if (Number.isFinite(step) && step > 0) {
    return true;
  }
  if (
    user.delivery_data_completed_at ||
    user.delivery_date ||
    user.delivery_date_iso ||
    user.delivery_time ||
    user.delivery_place ||
    user.delivery_birth_attendant ||
    user.delivery_with_complication ||
    user.baby_gender ||
    user.baby_birth_weight ||
    user.mother_current_complaint
  ) {
    return true;
  }
  const hplResponse = String(user.delivery_hpl_response || "")
    .trim()
    .toLowerCase();
  const hpl3Response = String(user.delivery_hpl3_response || "")
    .trim()
    .toLowerCase();
  return hplResponse === "sudah" || hpl3Response === "sudah";
}

async function restartUserDataFromBeginning(db, waId) {
  await clearPostpartumVisitLogs(db, waId);
  await updateUser(db, waId, {
    status: "onboarding",
    onboarding_step: 1,
    name: null,
    age: null,
    pregnancy_number: null,
    hpht: null,
    hpht_iso: null,
    routine_meds: null,
    tea: null,
    reminder_person: null,
    allow_remindcare: null,
    reminder_time: null,
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
  });
}

async function getUserDetail(db, waId) {
  const user = await dbGet(db, "SELECT * FROM users WHERE wa_id = ?", [waId]);
  const totals = await dbGet(
    db,
    `SELECT
       SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as total_sudah,
       SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as total_belum
     FROM reminder_logs
     WHERE wa_id = ?`,
    [waId],
  );
  const logs = await dbAll(
    db,
    `SELECT
       reminder_date,
       response,
       response_sudah_count,
       response_belum_count,
       created_at
     FROM reminder_logs
     WHERE wa_id = ?
     ORDER BY reminder_date DESC, id DESC`,
    [waId],
  );
  const postpartumLogs = await dbAll(
    db,
    `SELECT
       visit_code,
       visit_kind,
       visit_label,
       window_text,
       benefit_text,
       due_at,
       reminder_text_sent_at,
       sent_at,
       poll_message_id,
       last_attempt_at,
       fail_count,
       response,
       response_count,
       response_sudah_count,
       response_belum_count,
       response_at,
       created_at,
       updated_at
     FROM postpartum_visit_logs
     WHERE wa_id = ?
     ORDER BY due_at ASC, id ASC`,
    [waId],
  );
  const postpartumTotals = await dbGet(
    db,
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as sent,
       SUM(CASE WHEN response = 'Sudah' THEN 1 ELSE 0 END) as sudah,
       SUM(CASE WHEN response = 'Belum' THEN 1 ELSE 0 END) as belum
     FROM postpartum_visit_logs
     WHERE wa_id = ?`,
    [waId],
  );
  return {
    user,
    totals: {
      total_sudah: totals && totals.total_sudah ? totals.total_sudah : 0,
      total_belum: totals && totals.total_belum ? totals.total_belum : 0,
    },
    logs,
    postpartum_logs: postpartumLogs,
    postpartum_totals: {
      total:
        postpartumTotals && postpartumTotals.total ? postpartumTotals.total : 0,
      sent:
        postpartumTotals && postpartumTotals.sent ? postpartumTotals.sent : 0,
      sudah:
        postpartumTotals && postpartumTotals.sudah ? postpartumTotals.sudah : 0,
      belum:
        postpartumTotals && postpartumTotals.belum ? postpartumTotals.belum : 0,
    },
  };
}

async function getRecentLogs(db, limit = 50) {
  return dbAll(
    db,
    `SELECT
      reminder_date,
      wa_id,
      response,
      response_sudah_count,
      response_belum_count,
      created_at
     FROM reminder_logs
     ORDER BY reminder_date DESC, id DESC
     LIMIT ?`,
    [limit],
  );
}

async function handleAdminCommand(db, client, user, text) {
  const parsed = parseAdminCommand(text);
  if (!parsed) {
    return false;
  }

  if (!user.is_admin) {
    await sendText(
      client,
      user.wa_id,
      "Perintah admin hanya untuk admin ya. 🔒",
    );
    return true;
  }

  const { action, rawArgs } = parsed;
  if (action === "help") {
    await sendText(
      client,
      user.wa_id,
      "Perintah admin: admin stats, admin allow <wa_id>, admin block <wa_id>, admin unblock <wa_id>, admin purge logs <hari>. 🛠️",
    );
    return true;
  }

  if (action === "stats") {
    const stats = await getUserStats(db);
    await sendText(
      client,
      user.wa_id,
      `Stat user: total ${stats.total}, aktif ${stats.active}, allowed ${stats.allowed}, blocked ${stats.blocked}. 📊`,
    );
    return true;
  }

  if (action === "allow" || action === "block" || action === "unblock") {
    const target = normalizeWaIdInput(rawArgs);
    if (!target) {
      await sendText(
        client,
        user.wa_id,
        "Format: admin allow|block|unblock <wa_id>. ✍️",
      );
      return true;
    }

    const { user: targetUser } = await ensureUser(db, target);
    const updates = {};
    if (action === "allow") {
      updates.is_allowed = 1;
      updates.is_blocked = 0;
    } else if (action === "block") {
      updates.is_blocked = 1;
    } else if (action === "unblock") {
      updates.is_blocked = 0;
    }

    await updateUser(db, targetUser.wa_id, updates);
    await sendText(client, user.wa_id, `OK ${action} ${targetUser.wa_id}. ✅`);
    return true;
  }

  if (action === "purge") {
    const parts = rawArgs.split(/\s+/).filter(Boolean);
    let daysInput = null;
    if (parts.length === 1) {
      daysInput = parts[0];
    } else if (parts.length >= 2 && parts[0].toLowerCase() === "logs") {
      daysInput = parts[1];
    }
    const days = daysInput ? Number(daysInput) : REMINDER_LOG_RETENTION_DAYS;
    const removed = await purgeOldLogs(db, days);
    await sendText(
      client,
      user.wa_id,
      `Log dibersihkan: ${removed} baris (retensi ${Number.isFinite(days) ? days : "-"} hari). 🧹`,
    );
    return true;
  }

  await sendText(
    client,
    user.wa_id,
    "Perintah admin tidak dikenali. Ketik: admin help. 🤔",
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
  const [hour, minute] = reminderTime.split(":").map(Number);
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now > scheduled;
}

function shouldSendNow(reminderTime, now) {
  const [hour, minute] = reminderTime.split(":").map(Number);
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now >= scheduled;
}

function shouldSendBeforeReminder(reminderTime, now, leadHours = 2) {
  if (!reminderTime) {
    return false;
  }
  const [hour, minute] = String(reminderTime).split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }
  const scheduled = now.set({ hour, minute, second: 0, millisecond: 0 });
  const leadMoment = scheduled.minus({ hours: leadHours });
  return now >= leadMoment && now < scheduled;
}

function isPregnancyActive(user, now) {
  const start = getHphtDate(user);
  if (!start) {
    return true;
  }
  const weeksLimit =
    Number.isFinite(PREGNANCY_WEEKS_LIMIT) && PREGNANCY_WEEKS_LIMIT > 0
      ? PREGNANCY_WEEKS_LIMIT
      : 42;
  const end = start.plus({ weeks: weeksLimit }).endOf("day");
  return now <= end;
}

async function ensureReminderLog(db, waId, dateKey) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO reminder_logs (
      wa_id,
      reminder_date,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      created_at
    )
     VALUES (?, ?, NULL, 0, 0, 0, ?)`,
    [waId, dateKey, nowIso],
  );
}

async function recordDailyResponse(db, waId, dateKey, response) {
  await ensureReminderLog(db, waId, dateKey);
  const log = await dbGet(
    db,
    `SELECT response_sudah_count, response_belum_count
     FROM reminder_logs
     WHERE wa_id = ? AND reminder_date = ?`,
    [waId, dateKey],
  );
  const sudahCount =
    log && Number.isFinite(Number(log.response_sudah_count))
      ? Number(log.response_sudah_count)
      : 0;
  const belumCount =
    log && Number.isFinite(Number(log.response_belum_count))
      ? Number(log.response_belum_count)
      : 0;
  const limit = getMaxPollResponsesPerDay();
  const isSudah = response === "Sudah";
  const currentCount = isSudah ? sudahCount : belumCount;
  const allowed = limit === null || currentCount < limit;
  const nextSudah = isSudah && allowed ? sudahCount + 1 : sudahCount;
  const nextBelum = !isSudah && allowed ? belumCount + 1 : belumCount;
  await dbRun(
    db,
    `UPDATE reminder_logs
     SET response = ?, response_sudah_count = ?, response_belum_count = ?
     WHERE wa_id = ? AND reminder_date = ?`,
    [response, nextSudah, nextBelum, waId, dateKey],
  );
  return { allowed, limit, count: currentCount };
}

async function clearPostpartumVisitLogs(db, waId) {
  await dbRun(db, "DELETE FROM postpartum_visit_logs WHERE wa_id = ?", [waId]);
}

async function getPostpartumVisitLogs(db, waId) {
  return dbAll(
    db,
    `SELECT
      id,
      wa_id,
      visit_code,
      visit_kind,
      visit_label,
      window_text,
      benefit_text,
      due_at,
      reminder_text_sent_at,
      sent_at,
      poll_message_id,
      last_attempt_at,
      fail_count,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      response_at,
      created_at,
      updated_at
     FROM postpartum_visit_logs
     WHERE wa_id = ?
     ORDER BY due_at ASC, id ASC`,
    [waId],
  );
}

async function getPostpartumVisitLogByPollMessageId(db, waId, pollMessageId) {
  if (!pollMessageId) {
    return null;
  }
  return dbGet(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE wa_id = ? AND poll_message_id = ?`,
    [waId, pollMessageId],
  );
}

async function getLatestPendingPostpartumVisitLog(db, waId) {
  return dbGet(
    db,
    `SELECT *
     FROM postpartum_visit_logs
     WHERE wa_id = ?
       AND poll_message_id IS NOT NULL
       AND response IS NULL
     ORDER BY sent_at DESC, id DESC
     LIMIT 1`,
    [waId],
  );
}

async function ensurePostpartumVisitLog(db, waId, visit, dueAt) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO postpartum_visit_logs (
      wa_id,
      visit_code,
      visit_kind,
      visit_label,
      window_text,
      benefit_text,
      due_at,
      reminder_text_sent_at,
      sent_at,
      poll_message_id,
      last_attempt_at,
      fail_count,
      response,
      response_count,
      response_sudah_count,
      response_belum_count,
      response_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0, NULL, ?, ?)`,
    [
      waId,
      visit.code,
      visit.kind,
      visit.label,
      visit.windowText,
      visit.focusText,
      dueAt.toISO(),
      nowIso,
      nowIso,
    ],
  );
}

async function markPostpartumVisitSent(db, waId, visitCode, pollMessageId) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET sent_at = ?,
         poll_message_id = ?,
         last_attempt_at = ?,
         fail_count = 0,
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, pollMessageId, nowIso, nowIso, waId, visitCode],
  );
}

async function markPostpartumVisitTextSent(db, waId, visitCode) {
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET reminder_text_sent_at = COALESCE(reminder_text_sent_at, ?),
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, nowIso, waId, visitCode],
  );
}

async function markPostpartumVisitSendFailed(db, waId, visitCode, failCount) {
  const nowIso = nowWib().toISO();
  const nextFailCount =
    Number.isFinite(Number(failCount)) && Number(failCount) >= 0
      ? Number(failCount) + 1
      : 1;
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET last_attempt_at = ?,
         fail_count = ?,
         updated_at = ?
     WHERE wa_id = ? AND visit_code = ?`,
    [nowIso, nextFailCount, nowIso, waId, visitCode],
  );
}

async function recordPostpartumVisitResponse(db, visitLog, response) {
  const sudahCount =
    visitLog && Number.isFinite(Number(visitLog.response_sudah_count))
      ? Number(visitLog.response_sudah_count)
      : 0;
  const belumCount =
    visitLog && Number.isFinite(Number(visitLog.response_belum_count))
      ? Number(visitLog.response_belum_count)
      : 0;
  const responseCount =
    visitLog && Number.isFinite(Number(visitLog.response_count))
      ? Number(visitLog.response_count)
      : 0;
  const limit = getMaxPollResponsesPerDay();
  const isSudah = response === "Sudah";
  const currentCount = isSudah ? sudahCount : belumCount;
  const allowed = limit === null || currentCount < limit;
  const nextSudah = isSudah && allowed ? sudahCount + 1 : sudahCount;
  const nextBelum = !isSudah && allowed ? belumCount + 1 : belumCount;
  const nextResponseCount = allowed ? responseCount + 1 : responseCount;
  const nowIso = nowWib().toISO();
  await dbRun(
    db,
    `UPDATE postpartum_visit_logs
     SET response = ?,
         response_count = ?,
         response_sudah_count = ?,
         response_belum_count = ?,
         response_at = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      response,
      nextResponseCount,
      nextSudah,
      nextBelum,
      nowIso,
      nowIso,
      visitLog.id,
    ],
  );
  return { allowed, limit, count: currentCount };
}

async function sendPostpartumEducationIfNeeded(db, client, user, now) {
  if (
    !isPostpartumMonitoringActive(user) ||
    user.postpartum_education_sent_at
  ) {
    return false;
  }
  const sent = await sendText(
    client,
    user.wa_id,
    buildPostpartumEducationMessage(user, now),
  );
  if (!sent) {
    return false;
  }
  await updateUser(db, user.wa_id, {
    postpartum_education_sent_at: now.toISO(),
  });
  return true;
}

async function sendPostpartumVisitReminder(
  db,
  client,
  user,
  visit,
  visitLog,
  now,
) {
  if (
    !canAttemptByBackoff(
      visitLog && visitLog.last_attempt_at ? visitLog.last_attempt_at : null,
      visitLog && visitLog.fail_count ? visitLog.fail_count : 0,
      now,
    )
  ) {
    return false;
  }

  if (!visitLog || !visitLog.reminder_text_sent_at) {
    const reminderText = buildPostpartumVisitMessage(user, visit);
    const textSent = await sendText(client, user.wa_id, reminderText);
    if (textSent) {
      await markPostpartumVisitTextSent(db, user.wa_id, visit.code);
    }
  }

  const poll = new Poll(
    buildPostpartumVisitQuestion(visit),
    POSTPARTUM_POLL_OPTIONS,
    {
      allowMultipleAnswers: false,
    },
  );
  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error(
      "Gagal mengirim polling kunjungan untuk:",
      user.wa_id,
      visit.code,
    );
    await markPostpartumVisitSendFailed(
      db,
      user.wa_id,
      visit.code,
      visitLog && visitLog.fail_count ? visitLog.fail_count : 0,
    );
    return false;
  }

  await markPostpartumVisitSent(
    db,
    user.wa_id,
    visit.code,
    message.id._serialized,
  );
  return true;
}

async function processPostpartumVisitReminders(db, client, user, now) {
  if (!isPostpartumMonitoringActive(user)) {
    return;
  }
  const deliveryAt = getDeliveryDateTime(user);
  if (!deliveryAt) {
    return;
  }

  await sendPostpartumEducationIfNeeded(db, client, user, now);
  const logs = await getPostpartumVisitLogs(db, user.wa_id);
  const logByCode = new Map(logs.map((item) => [item.visit_code, item]));

  for (const visit of POSTPARTUM_VISIT_SCHEDULES) {
    const dueAt = getPostpartumDueAt(deliveryAt, visit);
    if (!dueAt) {
      continue;
    }

    let log = logByCode.get(visit.code);
    if (!log) {
      await ensurePostpartumVisitLog(db, user.wa_id, visit, dueAt);
      log = {
        visit_code: visit.code,
        reminder_text_sent_at: null,
        sent_at: null,
        last_attempt_at: null,
        fail_count: 0,
      };
      logByCode.set(visit.code, log);
    }

    if (log.sent_at || log.response || now < dueAt) {
      continue;
    }

    const sent = await sendPostpartumVisitReminder(
      db,
      client,
      user,
      visit,
      log,
      now,
    );
    if (sent) {
      break;
    }
  }
}

async function sendDailyPoll(db, client, user, now, options = {}) {
  const skipReminderText = options && options.skipReminderText === true;
  if (
    !canAttemptByBackoff(
      user.fe_poll_last_attempt_at,
      user.fe_poll_fail_count,
      now,
    )
  ) {
    return false;
  }

  const dateKey = toDateKey(now);
  if (!skipReminderText && user.last_reminder_text_date !== dateKey) {
    const reminderText = buildReminderMessage(user, now);
    const reminderSent = await sendText(client, user.wa_id, reminderText);
    if (reminderSent) {
      await updateUser(db, user.wa_id, { last_reminder_text_date: dateKey });
    }
  }

  const poll = new Poll(buildReminderQuestion(), REMINDER_POLL_OPTIONS, {
    allowMultipleAnswers: false,
  });

  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error("Gagal mengirim polling untuk:", user.wa_id);
    const failCount =
      Number.isFinite(Number(user.fe_poll_fail_count)) &&
      Number(user.fe_poll_fail_count) >= 0
        ? Number(user.fe_poll_fail_count) + 1
        : 1;
    await updateUser(db, user.wa_id, {
      fe_poll_last_attempt_at: now.toISO(),
      fe_poll_fail_count: failCount,
    });
    return false;
  }

  await updateUser(db, user.wa_id, {
    last_reminder_date: dateKey,
    last_poll_message_id: message.id._serialized,
    fe_poll_last_attempt_at: now.toISO(),
    fe_poll_fail_count: 0,
  });

  await ensureReminderLog(db, user.wa_id, dateKey);
  return true;
}

async function sendLaborPhaseMessage(db, client, user, now) {
  const today = toDateKey(now);
  if (user.last_labor_phase_message_date === today) {
    return false;
  }
  const phaseMessage = buildLaborPhaseMessage(user, now);
  if (!phaseMessage) {
    return false;
  }
  const sent = await sendText(client, user.wa_id, phaseMessage);
  if (!sent) {
    return false;
  }
  await updateUser(db, user.wa_id, { last_labor_phase_message_date: today });
  return true;
}

async function sendDeliveryValidationPoll(db, client, user, now, stage) {
  if (
    !canAttemptByBackoff(
      user.delivery_poll_last_attempt_at,
      user.delivery_poll_fail_count,
      now,
    )
  ) {
    return false;
  }

  const today = toDateKey(now);
  const shouldSendIntro =
    stage !== "week39_daily" &&
    (user.delivery_poll_intro_stage !== stage ||
      user.delivery_poll_intro_date !== today);
  if (shouldSendIntro) {
    const intro = buildDeliveryValidationMessage(user, now, stage);
    const introSent = await sendText(client, user.wa_id, intro);
    if (introSent) {
      await updateUser(db, user.wa_id, {
        delivery_poll_intro_stage: stage,
        delivery_poll_intro_date: today,
      });
    }
  }

  const poll = new Poll(
    buildDeliveryValidationQuestion(),
    DELIVERY_VALIDATION_POLL_OPTIONS,
    { allowMultipleAnswers: false },
  );
  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error("Gagal mengirim polling validasi lahir untuk:", user.wa_id);
    const failCount =
      Number.isFinite(Number(user.delivery_poll_fail_count)) &&
      Number(user.delivery_poll_fail_count) >= 0
        ? Number(user.delivery_poll_fail_count) + 1
        : 1;
    await updateUser(db, user.wa_id, {
      delivery_poll_last_attempt_at: now.toISO(),
      delivery_poll_fail_count: failCount,
    });
    return false;
  }

  const updates = {
    last_delivery_poll_message_id: message.id._serialized,
    delivery_poll_stage: stage,
    delivery_poll_last_attempt_at: now.toISO(),
    delivery_poll_fail_count: 0,
  };
  if (stage === "hpl3") {
    updates.delivery_hpl3_poll_sent_date = today;
  } else {
    updates.delivery_hpl_poll_sent_date = today;
  }
  await updateUser(db, user.wa_id, updates);
  return true;
}

function buildBelumDeliverySupportMessage() {
  const lines = [
    "Terima kasih sudah memberi kabar, Ibu. Tetap semangat ya.",
    "Tetap tenang dan pantau tanda persalinan seperti kontraksi teratur, keluar lendir bercampur darah, atau ketuban pecah.",
    "",
    "Yang sebaiknya dilakukan:",
    "1. Istirahat cukup dan jaga asupan cairan.",
    "2. Pantau gerakan janin secara berkala.",
    "3. Segera ke fasilitas kesehatan bila ada tanda bahaya.",
    "",
    `Baca artikel lanjutan di: ${DELIVERY_ARTICLE_URL}`,
  ];
  return lines.join("\n");
}

async function startDeliveryDataCollection(db, client, user) {
  await clearPostpartumVisitLogs(db, user.wa_id);
  await updateUser(db, user.wa_id, {
    delivery_poll_stage: null,
    last_delivery_poll_message_id: null,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
    delivery_poll_intro_stage: null,
    delivery_poll_intro_date: null,
    delivery_data_step: 1,
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
  });
  await sendText(client, user.wa_id, DELIVERY_QUESTIONS[0].text);
}

async function handleDeliveryValidationResponse(
  db,
  client,
  user,
  response,
  stageHint = null,
) {
  if (response !== "Sudah" && response !== "Belum") {
    return false;
  }

  const stage =
    stageHint ||
    getPendingDeliveryPollStage(user) ||
    getDeliveryValidationStageDue(user, nowWib());
  if (!stage) {
    return false;
  }
  if (
    (stage === "week39_daily" || stage === "hpl") &&
    user.delivery_hpl_response === "Sudah"
  ) {
    return true;
  }
  if (stage === "hpl3" && user.delivery_hpl3_response === "Sudah") {
    return true;
  }

  const nowIso = nowWib().toISO();
  const updates = {
    delivery_poll_stage: null,
    last_delivery_poll_message_id: null,
    delivery_poll_last_attempt_at: null,
    delivery_poll_fail_count: 0,
  };
  if (stage === "hpl3") {
    updates.delivery_hpl3_response = response;
    updates.delivery_hpl3_response_at = nowIso;
  } else if (stage !== "manual") {
    updates.delivery_hpl_response = response;
    updates.delivery_hpl_response_at = nowIso;
  }
  await updateUser(db, user.wa_id, updates);

  if (response === "Belum") {
    await sendText(client, user.wa_id, buildBelumDeliverySupportMessage());
    return true;
  }

  await sendText(
    client,
    user.wa_id,
    "Terima kasih, Ibu. Selamat atas kelahirannya. Kami lanjutkan pendataan persalinan singkat ya.",
  );
  await startDeliveryDataCollection(db, client, user);
  return true;
}

async function handleDeliveryDataAnswer(db, client, user, text) {
  const step = Number(user.delivery_data_step || 0);
  if (!Number.isFinite(step) || step <= 0) {
    return false;
  }

  const question = DELIVERY_QUESTIONS[step - 1];
  if (!question) {
    await updateUser(db, user.wa_id, { delivery_data_step: 0 });
    return false;
  }

  const raw = text ? text.trim() : "";
  if (!raw) {
    await sendText(
      client,
      user.wa_id,
      "Jawabannya belum terbaca. Bisa diulang?",
    );
    return true;
  }

  const updates = {};
  if (question.type === "date") {
    const parsed = parseHpht(raw);
    if (!parsed.iso) {
      await sendText(
        client,
        user.wa_id,
        "Format tanggal belum sesuai. Contoh: 31-01-2026.",
      );
      return true;
    }
    const dateValidation = validateDeliveryDateIso(parsed.iso, user, nowWib());
    if (!dateValidation.valid) {
      await sendText(client, user.wa_id, dateValidation.message);
      return true;
    }
    updates.delivery_date = parsed.raw;
    updates.delivery_date_iso = parsed.iso;
  } else if (question.type === "time") {
    const time = normalizeTimeInput(raw);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: 14:30.",
      );
      return true;
    }
    const deliveryDateIso = user.delivery_date_iso || updates.delivery_date_iso;
    const datetimeValidation = validateDeliveryDateTime(
      user,
      deliveryDateIso,
      time,
      nowWib(),
    );
    if (!datetimeValidation.valid) {
      await sendText(client, user.wa_id, datetimeValidation.message);
      return true;
    }
    updates.delivery_time = time;
  } else if (question.type === "yesno") {
    const yesNo = parseYesNo(raw);
    if (yesNo === null) {
      await sendText(client, user.wa_id, "Jawab dengan ya atau tidak ya.");
      return true;
    }
    updates.delivery_with_complication = yesNo
      ? "Dengan penyulit"
      : "Tidak dengan penyulit";
  } else if (question.type === "weight_gram") {
    const weight = normalizeBirthWeightGram(raw);
    if (!weight) {
      await sendText(
        client,
        user.wa_id,
        "Format berat belum sesuai. Tulis dalam gram, contoh: 3200 gram.",
      );
      return true;
    }
    updates[question.field] = weight;
  } else {
    updates[question.field] = raw;
  }

  const nextStep = step + 1;
  if (nextStep > DELIVERY_QUESTIONS.length) {
    updates.delivery_data_step = 0;
    updates.delivery_data_completed_at = nowWib().toISO();
    updates.postpartum_education_sent_at = null;
    await updateUser(db, user.wa_id, updates);
    await clearPostpartumVisitLogs(db, user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Terima kasih, data persalinan sudah dicatat. Jika ada perubahan, ketik *menu* untuk lihat perintah yang tersedia lalu kabari kami ya.",
    );
    await sendPostpartumEducationIfNeeded(
      db,
      client,
      { ...user, ...updates },
      nowWib(),
    );
    return true;
  }

  await updateUser(db, user.wa_id, {
    ...updates,
    delivery_data_step: nextStep,
  });
  await sendText(client, user.wa_id, DELIVERY_QUESTIONS[nextStep - 1].text);
  return true;
}

async function handlePostpartumVisitResponse(
  db,
  client,
  user,
  visitLog,
  response,
) {
  if (!visitLog || (response !== "Sudah" && response !== "Belum")) {
    return false;
  }

  const result = await recordPostpartumVisitResponse(db, visitLog, response);
  if (!result.allowed) {
    const visitLabel =
      visitLog.visit_label || visitLog.visit_code || "kunjungan";
    const limitText =
      result.limit === null
        ? `Jawaban ${visitLabel} sudah tercatat sebelumnya.`
        : `Jawaban ${response.toLowerCase()} untuk ${visitLabel} sudah mencapai batas ${result.limit}x hari ini.`;
    await sendText(
      client,
      user.wa_id,
      `${limitText} Tidak perlu kirim ulang ya.`,
    );
    return true;
  }

  const visit = POSTPARTUM_VISIT_BY_CODE.get(visitLog.visit_code) || {
    label: visitLog.visit_label || visitLog.visit_code,
  };

  if (response === "Sudah") {
    await sendText(
      client,
      user.wa_id,
      `Terima kasih, jawaban ${visit.label} sudah dicatat. Tetap lanjutkan kunjungan berikutnya sesuai jadwal ya.`,
    );
  } else {
    await sendText(
      client,
      user.wa_id,
      `Baik, jawaban ${visit.label} sudah dicatat. Mohon segera lakukan kunjungan ke tenaga kesehatan/fasilitas kesehatan.\nInfo lanjutan: ${DELIVERY_ARTICLE_URL}`,
    );
  }
  return true;
}

async function handleOnboardingAnswer(db, client, user, text) {
  const step = user.onboarding_step;
  const question = QUESTIONS[step - 1];

  if (!question) {
    await updateUser(db, user.wa_id, { status: "active", onboarding_step: 0 });
    return;
  }

  if (!text) {
    await sendText(
      client,
      user.wa_id,
      "Aku belum menangkap jawabannya. Bisa diulang? 🙂",
    );
    return;
  }

  const updates = {};

  if (question.type === "yesno") {
    const yesNo = parseYesNo(text);
    if (yesNo === null) {
      await sendText(client, user.wa_id, "Jawab dengan ya atau tidak, ya. 🙏");
      return;
    }
    updates[question.field] = yesNo ? 1 : 0;

    if (question.field === "allow_remindcare" && !yesNo) {
      await updateUser(db, user.wa_id, {
        ...updates,
        status: "active",
        onboarding_step: 0,
        reminder_time: null,
      });
      await sendText(
        client,
        user.wa_id,
        "Baik, RemindCare tidak akan mengingatkan dulu. Kalau berubah pikiran, ketik start. 👍",
      );
      return;
    }
  } else if (question.type === "time") {
    const time = normalizeTimeInput(text);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: 17:00. ⏰",
      );
      return;
    }
    updates[question.field] = time;
  } else if (question.field === "hpht") {
    const parsed = parseHpht(text);
    if (!parsed.iso) {
      await sendText(
        client,
        user.wa_id,
        "Format HPHT belum sesuai. Contoh: 31-01-2024. 📅",
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
    const shouldSkip = reminderTime
      ? shouldSkipToday(reminderTime, now)
      : false;
    const lastReminderDate = shouldSkip ? toDateKey(now) : null;

    await updateUser(db, user.wa_id, {
      ...updates,
      status: "active",
      onboarding_step: 0,
      last_reminder_date: lastReminderDate,
    });

    const finalTime = updates.reminder_time || user.reminder_time;
    await sendText(
      client,
      user.wa_id,
      `Siap! RemindCare akan mengingatkan setiap hari jam ${finalTime} WIB. ⏰✨`,
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
  const isCancelCmd = isCancelCommand(normalized);
  const isDeleteCmd = /^(delete|hapus)$/.test(normalized);
  const isEditDataCmd = isEditDataCommand(normalized);
  const isEditDeliveryCmd = isEditDeliveryCommand(normalized);
  const isDeliveryCheckCmd = isDeliveryCheckCommand(normalized);
  const isEditMenuCmd = isEditMenuCommand(normalized);

  if (!isCancelCmd && !isDeleteCmd && !isEditDataCmd && !isEditDeliveryCmd) {
    clearPendingConfirmation(user.wa_id);
  }

  if (isCancelCmd) {
    const cleared = clearPendingConfirmation(user.wa_id);
    await sendText(
      client,
      user.wa_id,
      cleared
        ? "Baik, konfirmasi edit/hapus dibatalkan."
        : "Tidak ada konfirmasi yang perlu dibatalkan saat ini.",
    );
    return true;
  }

  if (/^(help|menu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      `Menu:\n*start* - aktifkan pengingat\n*stop* - hentikan pengingat\n*ubah jam 17:00* - ganti jam pengingat\n*info* - ringkasan data penting ibu\n*cek persalinan* - tanya apakah Ibu sudah melahirkan\n*edit data* - isi ulang semua jawaban dari awal\n*edit persalinan* - isi ulang data persalinan\n*batal* - batalkan konfirmasi edit/hapus\n*about* - info singkat\n*website* - alamat website\n*delete* - hapus akun`,
    );
    return true;
  }

  if (/^(info|informasi)$/.test(normalized)) {
    const postpartumLogs = await getPostpartumVisitLogs(db, user.wa_id);
    const infoText = buildUserInfoMessage(user, postpartumLogs, nowWib());
    await sendText(client, user.wa_id, infoText);
    return true;
  }

  if (isEditMenuCmd) {
    await sendText(
      client,
      user.wa_id,
      "Perintah edit:\n*edit data* untuk isi ulang semua data dari awal.\n*edit persalinan* untuk isi ulang data persalinan.\n\nPerintah persalinan:\n*cek persalinan* untuk konfirmasi apakah Ibu sudah melahirkan.",
    );
    return true;
  }

  if (isDeliveryCheckCmd) {
    if (!user.hpht_iso) {
      await sendText(
        client,
        user.wa_id,
        "Data kehamilan belum lengkap. Lengkapi dulu ya, lalu nanti cek lagi status persalinannya.",
      );
      return true;
    }

    const deliveryStep = Number(user.delivery_data_step || 0);
    if (Number.isFinite(deliveryStep) && deliveryStep > 0) {
      const currentQuestion = DELIVERY_QUESTIONS[deliveryStep - 1];
      await sendText(
        client,
        user.wa_id,
        currentQuestion
          ? `Data persalinan sedang diisi. Lanjutkan dari pertanyaan ini ya:\n${currentQuestion.text}`
          : "Data persalinan sedang diisi. Lanjutkan jawaban berikutnya ya.",
      );
      return true;
    }

    if (isPostpartumMonitoringActive(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan sudah tercatat. Jika ada perubahan, ketik *edit persalinan* untuk isi ulang dari awal.",
      );
      return true;
    }

    if (hasAnyDeliveryRecord(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan sudah pernah tercatat sebagian. Jika mau isi ulang, ketik *edit persalinan*.",
      );
      return true;
    }

    const sent = await sendDeliveryValidationPoll(
      db,
      client,
      user,
      nowWib(),
      "manual",
    );
    if (!sent) {
      await sendText(
        client,
        user.wa_id,
        "Pertanyaan persalinan belum berhasil dikirim. Coba lagi sebentar ya.",
      );
    }
    return true;
  }

  if (isEditDataCmd) {
    const confirmed = checkEditConfirmation(user.wa_id, "data");
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Perintah ini akan mengosongkan jawaban profil, kehamilan, dan persalinan lalu mulai dari pertanyaan pertama.\nKetik *edit data* sekali lagi dalam 5 menit untuk lanjut, atau ketik *batal*.",
      );
      return true;
    }
    await restartUserDataFromBeginning(db, user.wa_id);
    clearPendingConfirmation(user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Baik, data direset. Kita isi ulang dari awal ya.",
    );
    await sendText(client, user.wa_id, QUESTIONS[0].text);
    return true;
  }

  if (isEditDeliveryCmd) {
    if (!hasAnyDeliveryRecord(user)) {
      await sendText(
        client,
        user.wa_id,
        "Data persalinan belum ada untuk diedit. Nanti setelah ada konfirmasi melahirkan, data persalinan bisa diisi.",
      );
      return true;
    }
    const confirmed = checkEditConfirmation(user.wa_id, "delivery");
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Perintah ini akan mengosongkan data persalinan dan jadwal kunjungan nifas yang sudah dibuat.\nKetik *edit persalinan* sekali lagi dalam 5 menit untuk lanjut, atau ketik *batal*.",
      );
      return true;
    }
    clearPendingConfirmation(user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Baik, kita isi ulang data persalinan dari awal.",
    );
    await startDeliveryDataCollection(db, client, user);
    return true;
  }

  if (/^(about|abotu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      "RemindCare adalah tugas akhir mahasiswa Poltekkes Kemenkes Tasikmalaya jurusan kebidanan (Melva). Informasi: 085156894979.",
    );
    return true;
  }

  if (/^website$/.test(normalized)) {
    await sendText(client, user.wa_id, "Website kami: remindcares.web.app");
    return true;
  }

  if (isDeleteCmd) {
    const confirmed = checkDeleteConfirmation(user.wa_id);
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Untuk menghapus akun, ketik delete sekali lagi.",
      );
      return true;
    }
    clearPendingConfirmation(user.wa_id);
    await deleteUserData(db, user.wa_id);
    await sendText(
      client,
      user.wa_id,
      "Akun kamu sudah dihapus. Kalau mau pakai lagi, cukup chat lagi ya.",
    );
    return true;
  }

  if (/^(stop|berhenti)$/.test(normalized)) {
    await updateUser(db, user.wa_id, { allow_remindcare: 0, status: "paused" });
    await sendText(client, user.wa_id, "Oke, pengingat dihentikan dulu. ⏸️");
    return true;
  }

  if (/^(start|mulai)$/.test(normalized)) {
    if (!user.reminder_time) {
      await updateUser(db, user.wa_id, {
        allow_remindcare: 1,
        status: "onboarding",
        onboarding_step: 9,
      });
      await sendText(client, user.wa_id, QUESTIONS[8].text);
      return true;
    }

    await updateUser(db, user.wa_id, { allow_remindcare: 1, status: "active" });
    await sendText(
      client,
      user.wa_id,
      `Siap, RemindCare aktif lagi jam ${user.reminder_time} WIB. ✅⏰`,
    );
    return true;
  }

  if (/^(ubah|set)\s+jam\b/.test(normalized) || /^jam\b/.test(normalized)) {
    const match = normalized.match(/(?:ubah|set)?\s*jam\s*(.*)$/);
    const timeInput = match && match[1] ? match[1] : "";
    const time = normalizeTimeInput(timeInput);
    if (!time) {
      await sendText(
        client,
        user.wa_id,
        "Format jam belum sesuai. Contoh: ubah jam 17:00. ⏰",
      );
      return true;
    }
    await updateUser(db, user.wa_id, {
      reminder_time: time,
      allow_remindcare: 1,
      status: "active",
    });
    await sendText(
      client,
      user.wa_id,
      `Jam pengingat diubah ke ${time} WIB. ✅⏰`,
    );
    return true;
  }

  return false;
}

async function handleDailyResponse(db, client, user, response) {
  const dateKey = toDateKey(nowWib());
  const result = await recordDailyResponse(db, user.wa_id, dateKey, response);
  if (!result.allowed) {
    const limitText =
      result.limit === null
        ? "Jawaban sudah tercatat sebelumnya."
        : `Jawaban ${response.toLowerCase()} sudah mencapai batas ${result.limit}x hari ini.`;
    await sendText(
      client,
      user.wa_id,
      `${limitText} Tidak perlu kirim ulang ya.`,
    );
    return;
  }

  if (response === "Sudah") {
    await sendText(
      client,
      user.wa_id,
      "Terima kasih. Semoga sehat selalu. 🌼",
    );
  } else if (response === "Belum") {
    await sendText(
      client,
      user.wa_id,
      "Baik, jangan lupa diminum ya. 💊🙂",
    );
  }
}

async function handleMessage(db, client, msg) {
  if (msg.fromMe) {
    return;
  }
  if (msg.from.endsWith("@g.us") || msg.isStatus) {
    return;
  }

  const text = msg.body ? msg.body.trim() : "";
  const waId = msg.from;
  if (isUnsupportedDirectTarget(waId)) {
    return;
  }
  const rateCheck = checkRateLimit(waId);
  if (!rateCheck.allowed) {
    if (rateCheck.warn) {
      await sendText(
        client,
        waId,
        "Terlalu banyak pesan. Coba lagi sebentar. ⏳",
      );
    }
    return;
  }

  const seed = {
    is_admin: ADMIN_WA_IDS.has(waId),
    is_allowed: ALLOWLIST_WA_IDS.has(waId),
  };
  const existingUser = await getUser(db, waId);
  if (
    !existingUser &&
    ENFORCE_ALLOWLIST &&
    !seed.is_allowed &&
    !seed.is_admin
  ) {
    await sendText(
      client,
      waId,
      "Nomor ini belum diizinkan. Hubungi admin. 🚫",
    );
    return;
  }
  if (!existingUser && !/^(start|mulai)$/.test(text.trim().toLowerCase())) {
    await sendText(
      client,
      waId,
      "Halo! 👋\nAku RemindCare, pengingat untuk menemani perjalanan ibu dari kehamilan, persalinan, masa nifas, hingga perawatan bayi. 🤍\n\nUntuk mulai, ketik *start* ya. ✨",
    );
    return;
  }

  const { user, isNew } = await ensureUser(db, waId, seed);

  if (user.is_blocked) {
    return;
  }

  if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
    await sendText(
      client,
      waId,
      "Nomor ini belum diizinkan. Hubungi admin. 🚫",
    );
    return;
  }

  if (isNew) {
    await sendText(client, waId, QUESTIONS[0].text);
    return;
  }

  if (user.status === "onboarding" && isAlwaysCommand(text)) {
    if (await handleCommand(db, client, user, text)) {
      return;
    }
  }

  if (user.status === "onboarding") {
    if (!isAlwaysCommand(text)) {
      clearPendingConfirmation(user.wa_id);
    }
    await handleOnboardingAnswer(db, client, user, text);
    return;
  }

  if (await handleCommand(db, client, user, text)) {
    return;
  }

  if (Number(user.delivery_data_step || 0) > 0) {
    await handleDeliveryDataAnswer(db, client, user, text);
    return;
  }

  const deliveryValidationAnswer = parseDeliveryValidationAnswer(text);
  const pendingDeliveryStage = getPendingDeliveryPollStage(user);
  if (deliveryValidationAnswer && pendingDeliveryStage) {
    await handleDeliveryValidationResponse(
      db,
      client,
      user,
      deliveryValidationAnswer,
      pendingDeliveryStage,
    );
    return;
  }

  const pollAnswer = parsePollAnswer(text);
  if (pollAnswer) {
    const today = toDateKey(nowWib());
    if (user.last_reminder_date === today) {
      await handleDailyResponse(db, client, user, pollAnswer);
      return;
    }

    const pendingPostpartumLog = await getLatestPendingPostpartumVisitLog(
      db,
      waId,
    );
    if (pendingPostpartumLog) {
      await handlePostpartumVisitResponse(
        db,
        client,
        user,
        pendingPostpartumLog,
        pollAnswer,
      );
      return;
    }

    await sendText(
      client,
      waId,
      "Belum ada polling hari ini. Tunggu pengingat berikutnya ya. ?",
    );
    return;
  }

  await sendText(
    client,
    waId,
    "Aku siap membantu pengingat tablet FE. Ketik menu untuk melihat perintah. 💬📋",
  );
}

async function handleVoteUpdate(db, client, vote) {
  const waId = vote.voter;
  if (isUnsupportedDirectTarget(waId)) {
    return;
  }
  const user = await getUser(db, waId);
  if (!user) {
    return;
  }

  if (user.is_blocked) {
    return;
  }

  const rateCheck = checkRateLimit(waId);
  if (!rateCheck.allowed) {
    if (rateCheck.warn) {
      await sendText(
        client,
        waId,
        "Terlalu banyak pesan. Coba lagi sebentar. ⏳",
      );
    }
    return;
  }

  if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
    return;
  }

  const pollMessageId =
    vote.parentMessage && vote.parentMessage.id
      ? vote.parentMessage.id._serialized
      : null;

  if (!vote.selectedOptions || vote.selectedOptions.length === 0) {
    return;
  }

  const response = parsePollAnswer(vote.selectedOptions[0].name);
  if (!response) {
    return;
  }

  if (
    user.last_delivery_poll_message_id &&
    pollMessageId &&
    user.last_delivery_poll_message_id === pollMessageId
  ) {
    await handleDeliveryValidationResponse(
      db,
      client,
      user,
      response,
      getPendingDeliveryPollStage(user),
    );
    return;
  }

  const postpartumLog = await getPostpartumVisitLogByPollMessageId(
    db,
    waId,
    pollMessageId,
  );
  if (postpartumLog) {
    await handlePostpartumVisitResponse(
      db,
      client,
      user,
      postpartumLog,
      response,
    );
    return;
  }

  const isFePoll =
    user.last_poll_message_id &&
    pollMessageId &&
    user.last_poll_message_id === pollMessageId;
  if (!isFePoll) {
    return;
  }

  await handleDailyResponse(db, client, user, response);
}

function getReminderLoopConcurrency() {
  if (!Number.isFinite(REMINDER_LOOP_CONCURRENCY)) {
    return 10;
  }
  const rounded = Math.floor(REMINDER_LOOP_CONCURRENCY);
  if (rounded <= 0) {
    return 1;
  }
  return rounded;
}

async function processUserReminderTick(db, client, user, now, today) {
  if (ENFORCE_ALLOWLIST && !user.is_allowed && !user.is_admin) {
    return;
  }

  const inPreReminderWindow = shouldSendBeforeReminder(
    user.reminder_time,
    now,
    2,
  );
  const canSendMainReminder = shouldSendNow(user.reminder_time, now);
  const postpartumActive = isPostpartumMonitoringActive(user);
  const deliveryConfirmed = hasConfirmedDelivery(user);
  const collectingDeliveryData =
    Number.isFinite(Number(user.delivery_data_step)) &&
    Number(user.delivery_data_step) > 0;
  if (postpartumActive && inPreReminderWindow) {
    await processPostpartumVisitReminders(db, client, user, now);
  }

  const deliveryStage = getDeliveryValidationStageDue(user, now);
  if (inPreReminderWindow && deliveryStage) {
    await sendDeliveryValidationPoll(db, client, user, now, deliveryStage);
  }

  if (!canSendMainReminder) {
    return;
  }

  if (
    !isPregnancyActive(user, now) &&
    !postpartumActive &&
    deliveryConfirmed &&
    !collectingDeliveryData
  ) {
    await updateUser(db, user.wa_id, {
      status: "completed",
      allow_remindcare: 0,
    });
    await sendText(
      client,
      user.wa_id,
      "Masa pengingat kehamilan sudah selesai. Jika ingin lanjut, balas start.",
    );
    return;
  }

  await sendLaborPhaseMessage(db, client, user, now);

  const deliveryValidationActive = isDeliveryValidationActive(user, now);

  if (user.last_reminder_date === today) {
    return;
  }

  await sendDailyPoll(db, client, user, now, {
    skipReminderText: deliveryValidationActive,
  });
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
          console.error("Gagal membersihkan log lama:", err);
        }
        lastCleanupDate = today;
      }

      const users = await dbAll(
        db,
        `SELECT * FROM users
         WHERE status = 'active'
         AND allow_remindcare = 1
         AND reminder_time IS NOT NULL
         AND is_blocked = 0`,
      );

      const concurrency = getReminderLoopConcurrency();
      for (let i = 0; i < users.length; i += concurrency) {
        const chunk = users.slice(i, i + concurrency);
        await Promise.all(
          chunk.map(async (user) => {
            try {
              await processUserReminderTick(db, client, user, now, today);
            } catch (err) {
              console.error("Gagal memproses reminder user:", user.wa_id, err);
            }
          }),
        );
      }
    } catch (err) {
      console.error("Gagal menjalankan pengingat:", err);
    } finally {
      reminderLoopRunning = false;
    }
  }, 30000);
}

function startAdminServer(db) {
  if (!ADMIN_WEB_ENABLED) {
    return;
  }
  if (!Number.isFinite(ADMIN_WEB_PORT) || ADMIN_WEB_PORT <= 0) {
    console.warn("Admin web tidak dijalankan: port tidak valid.");
    return;
  }

  const passwordConfig = getAdminPasswordConfig();

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const requireAdmin = (req, res, next) => {
    const token = getAdminSession(req);
    if (token) {
      return next();
    }
    const wantsJson =
      req.path.startsWith("/admin/api") ||
      (req.headers.accept || "").includes("application/json");
    if (wantsJson) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.redirect("/admin/login");
  };

  app.get("/admin/login", (req, res) => {
    res.send(renderAdminLoginPage(""));
  });

  app.post("/admin/login", (req, res) => {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (username && username !== ADMIN_WEB_USER) {
      res
        .status(401)
        .send(renderAdminLoginPage("Username atau password salah."));
      return;
    }
    if (!isPasswordMatch(password, passwordConfig.password)) {
      res
        .status(401)
        .send(renderAdminLoginPage("Username atau password salah."));
      return;
    }
    const token = createAdminSession();
    setAdminCookie(res, token);
    res.redirect("/admin");
  });

  app.post("/admin/logout", requireAdmin, (req, res) => {
    clearAdminCookie(res);
    res.redirect("/admin/login");
  });

  app.get("/admin", requireAdmin, (req, res) => {
    res.send(renderAdminDashboardPage());
  });

  app.get("/admin/api/summary", requireAdmin, async (req, res) => {
    try {
      const summary = await getAdminSummary(db);
      res.json(summary);
    } catch (err) {
      console.error("Gagal mengambil ringkasan admin:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/users", requireAdmin, async (req, res) => {
    try {
      const users = await getAdminUsers(db);
      res.json({ users });
    } catch (err) {
      console.error("Gagal mengambil data user:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/users/:waId", requireAdmin, async (req, res) => {
    const waId = String(req.params.waId || "").trim();
    if (!waId) {
      res.status(400).json({ error: "invalid" });
      return;
    }
    try {
      const detail = await getUserDetail(db, waId);
      if (!detail.user) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error("Gagal mengambil detail user:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get(
    "/admin/api/users/:waId/export.csv",
    requireAdmin,
    async (req, res) => {
      const waId = String(req.params.waId || "").trim();
      if (!waId) {
        res.status(400).json({ error: "invalid" });
        return;
      }
      try {
        const detail = await getUserDetail(db, waId);
        if (!detail.user) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const postpartumSnapshot = buildPostpartumSnapshot(
          detail.postpartum_logs || [],
        );
        const deliverySnapshot = {
          delivery_hpl_response: detail.user.delivery_hpl_response,
          delivery_hpl3_response: detail.user.delivery_hpl3_response,
          delivery_date:
            detail.user.delivery_date_iso || detail.user.delivery_date,
          delivery_time: detail.user.delivery_time,
          delivery_place: detail.user.delivery_place,
          delivery_birth_attendant: detail.user.delivery_birth_attendant,
          delivery_with_complication: detail.user.delivery_with_complication,
          baby_gender: detail.user.baby_gender,
          baby_birth_weight: detail.user.baby_birth_weight,
          mother_current_complaint: detail.user.mother_current_complaint,
          delivery_data_completed_at: detail.user.delivery_data_completed_at,
        };
        const logs =
          detail.logs && detail.logs.length > 0
            ? detail.logs
            : [
                {
                  reminder_date: null,
                  response: null,
                  response_sudah_count: null,
                  response_belum_count: null,
                  created_at: null,
                },
              ];
        const rows = logs.map((log) => ({
          ...log,
          ...deliverySnapshot,
          ...postpartumSnapshot,
        }));
        const csv = buildCsv(rows, [
          { key: "reminder_date", label: "reminder_date" },
          { key: "response", label: "response" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "created_at", label: "created_at" },
          { key: "delivery_hpl_response", label: "delivery_hpl_response" },
          { key: "delivery_hpl3_response", label: "delivery_hpl3_response" },
          { key: "delivery_date", label: "delivery_date" },
          { key: "delivery_time", label: "delivery_time" },
          { key: "delivery_place", label: "delivery_place" },
          {
            key: "delivery_birth_attendant",
            label: "delivery_birth_attendant",
          },
          {
            key: "delivery_with_complication",
            label: "delivery_with_complication",
          },
          { key: "baby_gender", label: "baby_gender" },
          { key: "baby_birth_weight", label: "baby_birth_weight" },
          {
            key: "mother_current_complaint",
            label: "mother_current_complaint",
          },
          {
            key: "delivery_data_completed_at",
            label: "delivery_data_completed_at",
          },
          { key: "postpartum_total", label: "postpartum_total" },
          { key: "postpartum_sent", label: "postpartum_sent" },
          { key: "postpartum_sudah", label: "postpartum_sudah" },
          { key: "postpartum_belum", label: "postpartum_belum" },
          { key: "postpartum_pending", label: "postpartum_pending" },
          { key: "kfkn1_confirmed_at", label: "kfkn1_confirmed_at" },
          { key: "kfkn2_confirmed_at", label: "kfkn2_confirmed_at" },
          { key: "kfkn3_confirmed_at", label: "kfkn3_confirmed_at" },
          { key: "kf4_confirmed_at", label: "kf4_confirmed_at" },
          {
            key: "postpartum_last_confirmed_at",
            label: "postpartum_last_confirmed_at",
          },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${waId.replace(/[^a-zA-Z0-9_-]/g, "_")}-logs.csv"`,
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export log user:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  app.get("/admin/api/logs", requireAdmin, async (req, res) => {
    try {
      const logs = await getRecentLogs(db, 50);
      res.json({ logs });
    } catch (err) {
      console.error("Gagal mengambil log:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get("/admin/api/export/users.csv", requireAdmin, async (req, res) => {
    try {
      const users = await getAdminUsers(db);
      const csv = buildCsv(users, [
        { key: "wa_id", label: "wa_id" },
        { key: "name", label: "name" },
        { key: "status", label: "status" },
        { key: "reminder_time", label: "reminder_time" },
        { key: "last_response_date", label: "last_response_date" },
        { key: "last_response", label: "last_response" },
        { key: "total_sudah", label: "total_sudah" },
        { key: "total_belum", label: "total_belum" },
        { key: "delivery_hpl_response", label: "delivery_hpl_response" },
        { key: "delivery_hpl3_response", label: "delivery_hpl3_response" },
        { key: "delivery_date_iso", label: "delivery_date_iso" },
        { key: "delivery_time", label: "delivery_time" },
        { key: "delivery_place", label: "delivery_place" },
        { key: "delivery_birth_attendant", label: "delivery_birth_attendant" },
        {
          key: "delivery_with_complication",
          label: "delivery_with_complication",
        },
        { key: "baby_gender", label: "baby_gender" },
        { key: "baby_birth_weight", label: "baby_birth_weight" },
        { key: "mother_current_complaint", label: "mother_current_complaint" },
        {
          key: "delivery_data_completed_at",
          label: "delivery_data_completed_at",
        },
        { key: "postpartum_total", label: "postpartum_total" },
        { key: "postpartum_sent", label: "postpartum_sent" },
        { key: "postpartum_sudah", label: "postpartum_sudah" },
        { key: "postpartum_belum", label: "postpartum_belum" },
      ]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="users.csv"');
      res.send(csv);
    } catch (err) {
      console.error("Gagal export users:", err);
      res.status(500).json({ error: "failed" });
    }
  });

  app.get(
    "/admin/api/export/reminder_logs.csv",
    requireAdmin,
    async (req, res) => {
      try {
        const logs = await dbAll(
          db,
          `SELECT
          reminder_date,
          wa_id,
          response,
          response_sudah_count,
          response_belum_count,
          created_at
         FROM reminder_logs
         ORDER BY reminder_date DESC, id DESC`,
        );
        const csv = buildCsv(logs, [
          { key: "reminder_date", label: "reminder_date" },
          { key: "wa_id", label: "wa_id" },
          { key: "response", label: "response" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "created_at", label: "created_at" },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="reminder_logs.csv"',
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export log:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  app.get(
    "/admin/api/export/postpartum_logs.csv",
    requireAdmin,
    async (req, res) => {
      try {
        const logs = await dbAll(
          db,
          `SELECT
            wa_id,
            visit_code,
            visit_kind,
            visit_label,
            window_text,
            benefit_text,
            due_at,
            reminder_text_sent_at,
            sent_at,
            poll_message_id,
            last_attempt_at,
            fail_count,
            response,
            response_count,
            response_sudah_count,
            response_belum_count,
            response_at,
            created_at,
            updated_at
           FROM postpartum_visit_logs
           ORDER BY due_at DESC, id DESC`,
        );
        const csv = buildCsv(logs, [
          { key: "wa_id", label: "wa_id" },
          { key: "visit_code", label: "visit_code" },
          { key: "visit_kind", label: "visit_kind" },
          { key: "visit_label", label: "visit_label" },
          { key: "window_text", label: "window_text" },
          { key: "benefit_text", label: "benefit_text" },
          { key: "due_at", label: "due_at" },
          { key: "reminder_text_sent_at", label: "reminder_text_sent_at" },
          { key: "sent_at", label: "sent_at" },
          { key: "poll_message_id", label: "poll_message_id" },
          { key: "last_attempt_at", label: "last_attempt_at" },
          { key: "fail_count", label: "fail_count" },
          { key: "response", label: "response" },
          { key: "response_count", label: "response_count" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "response_at", label: "response_at" },
          { key: "created_at", label: "created_at" },
          { key: "updated_at", label: "updated_at" },
        ]);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="postpartum_visit_logs.csv"',
        );
        res.send(csv);
      } catch (err) {
        console.error("Gagal export postpartum log:", err);
        res.status(500).json({ error: "failed" });
      }
    },
  );

  app.listen(ADMIN_WEB_PORT, () => {
    console.log(
      `Admin web berjalan di http://localhost:${ADMIN_WEB_PORT}/admin`,
    );
    if (passwordConfig.source === "generated") {
      console.log(`Password admin dibuat: ${passwordConfig.password}`);
      if (passwordConfig.filePath) {
        console.log(`Password tersimpan di: ${passwordConfig.filePath}`);
      }
    }
  });
}

async function main() {
  ensureDataDir();
  const db = openDb();
  await initDb(db);
  startAdminServer(db);

  const executablePath = findBrowserExecutable();
  if (executablePath) {
    console.log(`Menggunakan browser: ${executablePath}`);
  }

  const runningAsRoot =
    typeof process.getuid === "function" && process.getuid() === 0;
  const disableSandbox = DISABLE_SANDBOX || runningAsRoot;
  if (runningAsRoot && !DISABLE_SANDBOX) {
    console.warn("Running as root, otomatis menonaktifkan sandbox Chromium.");
  }
  const puppeteerArgs = disableSandbox
    ? ["--no-sandbox", "--disable-setuid-sandbox"]
    : [];

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      ...(puppeteerArgs.length ? { args: puppeteerArgs } : {}),
    },
  });
  activeClient = client;

  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    console.log("RemindCare siap digunakan.");
  });

  client.on("message", async (msg) => {
    try {
      await handleMessage(db, client, msg);
    } catch (err) {
      console.error("Gagal memproses pesan:", err);
    }
  });

  client.on("vote_update", async (vote) => {
    try {
      await handleVoteUpdate(db, client, vote);
    } catch (err) {
      console.error("Gagal memproses vote:", err);
    }
  });

  client.initialize();
  startReminderLoop(db, client);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("RemindCare gagal dijalankan:", err);
  });
}

module.exports = {
  parseYesNo,
  normalizeTimeInput,
  parseHpht,
  shouldSendNow,
  getHplDate,
  getDeliveryValidationStageDue,
  buildLaborPhaseMessage,
  parseDeliveryValidationAnswer,
  getDeliveryDateTime,
  getPostpartumDueAt,
  buildPostpartumSnapshot,
  getRetryDelayMs,
  canAttemptByBackoff,
  validateDeliveryDateIso,
  validateDeliveryDateTime,
  isDeliveryCheckCommand,
};
