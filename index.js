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
const PREGNANCY_MONTHS_LIMIT = 9;
const REMINDER_POLL_QUESTION = "Sudah minum tablet FE hari ini? 💊😊";
const REMINDER_POLL_OPTIONS = ["Sudah ✅", "Belum ⏳"];
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

function isAlwaysCommand(text) {
  if (!text) {
    return false;
  }
  const normalized = text.trim().toLowerCase();
  return /^(help|menu|about|abotu|website|delete|hapus)$/.test(normalized);
}

function checkDeleteConfirmation(waId) {
  const nowMs = Date.now();
  const existing = deleteConfirmState.get(waId);
  if (existing && nowMs - existing < 5 * 60 * 1000) {
    deleteConfirmState.delete(waId);
    return true;
  }
  deleteConfirmState.set(waId, nowMs);
  return false;
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

function sendText(client, chatId, text) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  return resolved
    .sendMessage(chatId, text, { sendSeen: false })
    .catch((err) => {
      console.error("Gagal mengirim pesan:", err);
      return null;
    });
}

function sendPoll(client, chatId, poll) {
  const resolved = resolveClient(client);
  if (!resolved) {
    console.error("Client belum siap untuk mengirim pesan.");
    return null;
  }
  return resolved
    .sendMessage(chatId, poll, { sendSeen: false })
    .catch((err) => {
      console.error("Gagal mengirim polling:", err);
      return null;
    });
}

function nowWib() {
  return DateTime.now().setZone(TIMEZONE);
}

function toDateKey(dt) {
  return dt.toFormat("yyyy-LL-dd");
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
  const parts = [
    `rc_admin=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "rc_admin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  );
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

  await ensureUserColumns(db);
  await ensureReminderLogColumns(db);
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
  await dbRun(db, "DELETE FROM reminder_logs WHERE wa_id = ?", [waId]);
  await dbRun(db, "DELETE FROM users WHERE wa_id = ?", [waId]);
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
  return {
    user,
    totals: {
      total_sudah: totals && totals.total_sudah ? totals.total_sudah : 0,
      total_belum: totals && totals.total_belum ? totals.total_belum : 0,
    },
    logs,
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

function isPregnancyActive(user, now) {
  if (!user.hpht_iso) {
    return true;
  }
  const start = DateTime.fromISO(user.hpht_iso, { zone: TIMEZONE });
  if (!start.isValid) {
    return true;
  }
  const end = start.plus({ months: PREGNANCY_MONTHS_LIMIT }).endOf("day");
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

async function sendDailyPoll(db, client, user, now) {
  const reminderText = buildReminderMessage(user, now);
  await sendText(client, user.wa_id, reminderText);

  const poll = new Poll(buildReminderQuestion(), REMINDER_POLL_OPTIONS, {
    allowMultipleAnswers: false,
  });

  const message = await sendPoll(client, user.wa_id, poll);
  if (!message || !message.id || !message.id._serialized) {
    console.error("Gagal mengirim polling untuk:", user.wa_id);
    return;
  }
  const dateKey = toDateKey(now);

  await updateUser(db, user.wa_id, {
    last_reminder_date: dateKey,
    last_poll_message_id: message.id._serialized,
  });

  await ensureReminderLog(db, user.wa_id, dateKey);
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

  if (/^(help|menu)$/.test(normalized)) {
    await sendText(
      client,
      user.wa_id,
      `Menu:\n*start* - aktifkan pengingat\n*stop* - hentikan pengingat\n*ubah jam 17:00* - ganti jam pengingat\n*about* - info singkat\n*website* - alamat website\n*delete* - hapus akun`,
    );
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

  if (/^(delete|hapus)$/.test(normalized)) {
    const confirmed = checkDeleteConfirmation(user.wa_id);
    if (!confirmed) {
      await sendText(
        client,
        user.wa_id,
        "Untuk menghapus akun, ketik delete sekali lagi.",
      );
      return true;
    }
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
    return;
  }

  if (response === "Sudah") {
    await sendText(client, user.wa_id, "Terima kasih. Semoga sehat selalu. 🌼");
  } else if (response === "Belum") {
    await sendText(client, user.wa_id, "Baik, jangan lupa diminum ya. 💊🙂");
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
  if (!existingUser && isGreeting(text)) {
    await sendText(
      client,
      waId,
      "Halo! 👋 Aku RemindCare, bot pengingat tablet FE untuk ibu hamil supaya minum obat tepat waktu. 🤰💊\n\nUntuk mulai, ketik start ya. ✨\n\nCara pakai: jawab pertanyaan, pilih jam pengingat, lalu terima reminder harian. ⏰\nBaca artikel seputar kehamilan di remindcares.web.app 📚🌐",
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
      await sendText(
        client,
        waId,
        "Belum ada polling hari ini. Tunggu pengingat berikutnya ya. ⏳",
      );
      return;
    }
    await handleDailyResponse(db, client, user, pollAnswer);
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
        "Terlalu banyak pesan. Coba lagi sebentar. â³",
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

  if (
    user.last_poll_message_id &&
    pollMessageId &&
    user.last_poll_message_id !== pollMessageId
  ) {
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
          await updateUser(db, user.wa_id, {
            status: "completed",
            allow_remindcare: 0,
          });
          await sendText(
            client,
            user.wa_id,
            "Masa pengingat 9 bulan sudah selesai. Jika ingin lanjut, balas start. 🎉",
          );
          continue;
        }

        await sendDailyPoll(db, client, user, now);
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
        const csv = buildCsv(detail.logs, [
          { key: "reminder_date", label: "reminder_date" },
          { key: "response", label: "response" },
          { key: "response_sudah_count", label: "response_sudah_count" },
          { key: "response_belum_count", label: "response_belum_count" },
          { key: "created_at", label: "created_at" },
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
};
