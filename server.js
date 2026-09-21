const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// Carga el archivo .env (sin dependencias) para poder configurar todo ahí.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (_) {}

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, 'state.json');
const PORT = process.env.PORT || 3000;
const DEFAULT_URL = 'https://megapersonals.eu/';

// Dispositivos disponibles por perfil (User-Agent + pantalla, coherentes entre si).
function devicePreset(name, chromeMajor) {
  const major = String(chromeMajor || '140');
  const presets = {
    iphone: {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      kind: 'iphone', platform: 'iOS', model: 'iPhone', androidVersion: ''
    },
    android: {
      userAgent: `Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: 'Pixel 9', androidVersion: '16.0.0'
    },
    pixel: {
      userAgent: `Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: 'Pixel 10', androidVersion: '16.0.0'
    },
    pixel_pro: {
      userAgent: `Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      viewport: { width: 412, height: 915, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: 'Pixel 10 Pro', androidVersion: '16.0.0'
    },
    samsung: {
      userAgent: `Mozilla/5.0 (Linux; Android 16; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: 'SM-S931B', androidVersion: '16.0.0'
    },
    samsung_ultra: {
      userAgent: `Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      viewport: { width: 412, height: 915, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: 'SM-S938B', androidVersion: '16.0.0'
    }
  };
  return presets[name] || presets.iphone;
}
const DEFAULT_SUPPORT_EMAIL = 'support@megapersonals.eu';
const TWOCAPTCHA_BASE = (process.env.TWOCAPTCHA_BASE || 'https://2captcha.com').replace(/\/+$/, '');
const twoCaptchaStats = { solves: 0, fails: 0, balance: null, lastBalanceAt: 0 };

function siteUrls(controller) {
  const configuredUrl = controller?.cfg?.url || DEFAULT_URL;
  const origin = new URL(configuredUrl).origin;
  const hostname = new URL(configuredUrl).hostname;
  return {
    manage: `${origin}/users/posts/list?publicDomain=${encodeURIComponent(hostname)}`,
    list: `${origin}/users/posts/list`,
    create: `${origin}/users/posts/create`
  };
}

// Detecta errores tipicos de falta de internet / conexion perdida.
function isNetworkError(error) {
  const msg = String((error && error.message) || error || '');
  return /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_NETWORK_CHANGED|ERR_NETWORK|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION|ERR_TUNNEL|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|getaddrinfo|net::ERR|Navigation timeout|Timeout .* exceeded|Target closed|Session closed|Protocol error/i.test(msg);
}

const AUTH_COOKIE = 'momonga_auth';
const AUTH_STORE_PATH = process.env.PANEL_AUTH_PATH || path.join(__dirname, 'panel-auth.json');
const DEFAULT_PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'momonga';

function hashPanelPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function loadPanelAuth() {
  try {
    if (!fs.existsSync(AUTH_STORE_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(AUTH_STORE_PATH, 'utf8'));
    if (data && typeof data.salt === 'string' && typeof data.hash === 'string') return data;
  } catch (_) {
    // almacén corrupto o inexistente: se usa la contraseña por defecto
  }
  return null;
}

let panelAuth = loadPanelAuth();

function computeAuthToken() {
  const secret = panelAuth ? panelAuth.hash : DEFAULT_PANEL_PASSWORD;
  return crypto.createHash('sha256').update(`momonga-pro:${secret}`).digest('hex');
}

let AUTH_TOKEN = computeAuthToken();

function verifyPanelPassword(password) {
  const candidate = Buffer.from(String(password || ''));
  if (panelAuth) {
    const expected = Buffer.from(panelAuth.hash, 'hex');
    const actual = Buffer.from(hashPanelPassword(candidate.toString(), panelAuth.salt), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const expected = Buffer.from(DEFAULT_PANEL_PASSWORD);
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function savePanelPassword(newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  panelAuth = { salt, hash: hashPanelPassword(newPassword, salt) };
  fs.writeFileSync(AUTH_STORE_PATH, `${JSON.stringify(panelAuth, null, 2)}\n`, 'utf8');
  AUTH_TOKEN = computeAuthToken();
}

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE] === AUTH_TOKEN;
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MOMONGA PRO - Acceso</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; background:#0f0f16; color:#fff; font-family:Arial,sans-serif; }
  form { background:#151522; border:1px solid #2a2a40; border-radius:10px; padding:28px; width:300px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
  h1 { font-size:18px; margin:0 0 4px; color:#4ecca3; }
  p.sub { font-size:12px; color:#888; margin:0 0 18px; }
  input { width:100%; box-sizing:border-box; background:#1a1a2e; border:1px solid #333; color:#fff; padding:10px; border-radius:6px; font-size:13px; margin-bottom:14px; }
  button { width:100%; background:#4ecca3; color:#000; border:none; padding:10px; border-radius:6px; font-weight:bold; cursor:pointer; font-size:13px; }
  button:hover { opacity:.9; }
</style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>MOMONGA PRO</h1>
    <p class="sub">Panel de control</p>
    <!--ERROR-->
    <input type="password" name="password" placeholder="Contraseña del panel" autofocus required>
    <button type="submit">Entrar</button>
  </form>
</body>
</html>`;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/login', (req, res) => {
  res.type('html').send(LOGIN_PAGE);
});

app.post('/login', (req, res) => {
  if (verifyPanelPassword(req.body?.password)) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    return res.redirect('/');
  }
  res.status(401).type('html').send(LOGIN_PAGE.replace('<!--ERROR-->', '<p style="color:#e74c3c;margin:0 0 12px;font-size:12px;">Contraseña incorrecta.</p>'));
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/favicon.ico') return next();
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado. Inicia sesión en el panel.' });
  return res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/security/password', (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!verifyPanelPassword(currentPassword)) {
      return res.status(403).json({ success: false, error: 'La contraseña actual no es correcta.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'La nueva contraseña debe tener al menos 8 caracteres.' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ success: false, error: 'La nueva contraseña debe ser distinta a la actual.' });
    }

    savePanelPassword(newPassword);
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
    res.json({ success: true, message: 'Contraseña del panel actualizada.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function readAppealsIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(APPEALS_DIR, 'index.json'), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

app.get('/api/appeals', (req, res) => {
  res.json(readAppealsIndex().slice().reverse());
});

app.get('/api/appeals/:id/draft', (req, res) => {
  const record = readAppealsIndex().find((item) => item.id === req.params.id);
  if (!record) return res.status(404).json({ success: false, error: 'Bloqueo no encontrado.' });
  res.json({ success: true, ...buildAppealDraft(record) });
});

app.get('/api/appeals/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(APPEALS_DIR, file);
  if (path.dirname(full) !== APPEALS_DIR || !fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

app.post('/api/appeals/open-folder', (req, res) => {
  try {
    fs.mkdirSync(APPEALS_DIR, { recursive: true });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [APPEALS_DIR], { windowsHide: true }, () => {});
    res.json({ success: true, path: APPEALS_DIR });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

function writeAppealsIndex(index) {
  fs.mkdirSync(APPEALS_DIR, { recursive: true });
  fs.writeFileSync(path.join(APPEALS_DIR, 'index.json'), `${JSON.stringify(index.slice(-200), null, 2)}\n`, 'utf8');
}

function deleteAppealFiles(record) {
  for (const f of [record.screenshot, record.html]) {
    if (!f) continue;
    try { fs.unlinkSync(path.join(APPEALS_DIR, path.basename(f))); } catch (_) {}
  }
}

app.delete('/api/appeals/:id', (req, res) => {
  try {
    const index = readAppealsIndex();
    const record = index.find((item) => item.id === req.params.id);
    if (!record) return res.status(404).json({ success: false, error: 'Bloqueo no encontrado.' });
    deleteAppealFiles(record);
    writeAppealsIndex(index.filter((item) => item.id !== req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/appeals', (req, res) => {
  try {
    const index = readAppealsIndex();
    for (const record of index) deleteAppealFiles(record);
    writeAppealsIndex([]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  if (cookies[AUTH_COOKIE] === AUTH_TOKEN) return next();
  next(new Error('unauthorized'));
});

// --- Backups y cifrado de secretos ---
const BACKUPS_DIR = path.join(__dirname, 'backups');
const SECRETS_KEY_PATH = process.env.SECRETS_KEY_PATH || path.join(__dirname, '.secrets-key');
const BACKUPS_KEEP = 20;

function backupFile(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) return;
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(filePath, path.join(BACKUPS_DIR, `${label}-${stamp}.json`));
    const files = fs.readdirSync(BACKUPS_DIR).filter((f) => f.startsWith(`${label}-`)).sort();
    while (files.length > BACKUPS_KEEP) fs.unlinkSync(path.join(BACKUPS_DIR, files.shift()));
  } catch (_) {
    // si falla el backup, no interrumpe
  }
}

let _secretsKey = null;
function secretsKey() {
  if (_secretsKey) return _secretsKey;
  try {
    if (fs.existsSync(SECRETS_KEY_PATH)) {
      const k = fs.readFileSync(SECRETS_KEY_PATH, 'utf8').trim();
      if (/^[0-9a-f]{64}$/i.test(k)) {
        _secretsKey = Buffer.from(k, 'hex');
        return _secretsKey;
      }
    }
  } catch (_) {}
  const key = crypto.randomBytes(32);
  try { fs.writeFileSync(SECRETS_KEY_PATH, key.toString('hex'), 'utf8'); } catch (_) {}
  _secretsKey = key;
  return _secretsKey;
}

function encryptSecret(value) {
  const v = String(value == null ? '' : value);
  if (!v || v.startsWith('enc:')) return v;
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretsKey(), iv);
    const enc = Buffer.concat([cipher.update(v, 'utf8'), cipher.final()]);
    return `enc:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
  } catch (_) {
    return v;
  }
}

function decryptSecret(value) {
  const v = String(value == null ? '' : value);
  if (!v.startsWith('enc:')) return v;
  try {
    const raw = Buffer.from(v.slice(4), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretsKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (_) {
    return '';
  }
}

function mapConfigSecrets(config, fn) {
  return config.map((p) => {
    const c = { ...p };
    if (c.password) c.password = fn(c.password);
    if (c.apiKey2Captcha) c.apiKey2Captcha = fn(c.apiKey2Captcha);
    if (c.proxy && c.proxy.password) c.proxy = { ...c.proxy, password: fn(c.proxy.password) };
    return c;
  });
}

function saveConfig(config) {
  backupFile(CONFIG_PATH, 'config');
  const toWrite = mapConfigSecrets(config, encryptSecret);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return [];
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config)) {
    throw new Error('config.json debe contener un array de perfiles.');
  }
  return mapConfigSecrets(config, decryptSecret);
}

const LOGS_DIR = path.join(__dirname, 'logs');
const APPEALS_DIR = path.join(LOGS_DIR, 'appeals');

function logToFile(prefix, text) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const now = new Date();
    const day = todayKey();
    const stamp = now.toLocaleTimeString('es-ES', { hour12: false });
    fs.appendFileSync(path.join(LOGS_DIR, `${day}.log`), `[${day} ${stamp}] [${prefix}] ${text}\n`, 'utf8');
  } catch (_) {
    // no romper la app por un fallo de logging
  }
}

function serverLog(text) {
  console.log('[server]', text);
  logToFile('server', text);
}

function pruneLogs(maxDays = 30) {
  try {
    const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')).sort();
    while (files.length > maxDays) {
      fs.unlinkSync(path.join(LOGS_DIR, files.shift()));
    }
  } catch (_) {
    // sin logs que rotar
  }
}

const NOTIFY_PATH = process.env.NOTIFY_PATH || path.join(__dirname, 'notifications.json');

function loadNotifyConfig() {
  try { return JSON.parse(fs.readFileSync(NOTIFY_PATH, 'utf8')) || {}; } catch (_) { return {}; }
}

function saveNotifyConfig(cfg) {
  fs.writeFileSync(NOTIFY_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

async function notify(message) {
  const text = `MOMONGA PRO\n${message}`;
  const tasks = [];
  const cfg = loadNotifyConfig();

  const tgToken = cfg.telegramToken || process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    tasks.push(undiciFetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text })
    }).catch(() => {}));
  }

  const discord = cfg.discordWebhook || process.env.DISCORD_WEBHOOK_URL;
  if (discord) {
    tasks.push(undiciFetch(discord, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    }).catch(() => {}));
  }

  await Promise.all(tasks);
}

// --- Control por Telegram (menú con botones para todas las cuentas) ---
function tgConfig() {
  const cfg = loadNotifyConfig();
  return {
    token: cfg.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: String(cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID || '').trim()
  };
}

async function tgCall(token, method, payload) {
  try {
    const r = await undiciFetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await r.json().catch(() => ({}));
  } catch (_) {
    return {};
  }
}

function accountsText() {
  const list = [...controllers.values()];
  if (list.length === 0) return 'MOMONGA PRO\n\nNo hay cuentas configuradas.';
  const lines = list.map((c) => {
    const estado = c.started ? (c.paused ? '⏸ pausado' : '🟢 activo') : '⚪ detenido';
    return `• *${c.id}* — ${estado}\n   ${c.cycleStage || '-'} · bumps hoy: ${c.stats.bumpsToday || 0}`;
  });
  return `MOMONGA PRO — Cuentas (${list.length})\n\n${lines.join('\n')}`;
}

function accountsKeyboard() {
  const rows = [
    [
      { text: '🖼 Ver panel completo', callback_data: 'panel' },
      { text: '🔄 Actualizar', callback_data: 'menu' }
    ],
    [
      { text: '▶️ Iniciar todos', callback_data: 'all:start' },
      { text: '⏸ Pausar todos', callback_data: 'all:pause' },
      { text: '⏹ Detener todos', callback_data: 'all:stop' }
    ]
  ];
  for (const c of controllers.values()) {
    const id = String(c.id).slice(0, 40);
    rows.push([
      { text: `👁 ${id}`, callback_data: `view:${id}` },
      { text: '▶️', callback_data: `start:${id}` },
      { text: '⏸', callback_data: `pause:${id}` },
      { text: '⏹', callback_data: `stop:${id}` },
      { text: '📢', callback_data: `publish:${id}` },
      { text: '📺', callback_data: `live:${id}` }
    ]);
  }
  return { inline_keyboard: rows };
}

function tgSend(token, chatId, text) {
  return tgCall(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
}

const TG_FIELDS = {
  nombre: 'adDetails.name', name: 'adDetails.name',
  titulo: 'adDetails.headline', headline: 'adDetails.headline',
  ciudad: 'adDetails.city', city: 'adDetails.city',
  edad: 'adDetails.age', age: 'adDetails.age',
  ubicacion: 'adDetails.location', location: 'adDetails.location',
  telefono: 'adDetails.phone', phone: 'adDetails.phone',
  texto: 'adDetails.text', text: 'adDetails.text',
  fotos: 'adDetails.photosPath', photos: 'adDetails.photosPath',
  email: 'email',
  password: 'password',
  apikey: 'apiKey2Captcha',
  proxy: 'proxy'
};

// Arma un cuerpo multipart/form-data (FormData+Blob no funciona con este fetch)
function buildMultipart(fields, fileField, fileName, fileBuffer, fileType) {
  const boundary = `----momonga${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(parts) };
}

// Manda una captura del panel web completo a Telegram (como ver la misma página).
async function tgSendPanelScreenshot(token, chatId) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie({ name: AUTH_COOKIE, value: AUTH_TOKEN, url: `http://localhost:${PORT}/` });
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);
    const pngBase64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
    const buffer = Buffer.from(pngBase64, 'base64');
    const { boundary, body } = buildMultipart({ chat_id: String(chatId), caption: 'MOMONGA PRO — Panel completo' }, 'photo', 'panel.png', buffer, 'image/png');
    const r = await undiciFetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) await tgSend(token, chatId, `No se pudo enviar la captura: ${data.description || r.status}`);
  } catch (error) {
    await tgSend(token, chatId, `No se pudo generar la captura: ${error.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Vista "en vivo" en Telegram: refresca una foto del navegador de la cuenta cada pocos segundos.
const tgLiveViews = new Map();

function stopTgLive(chatId, id) {
  const key = `${chatId}:${id}`;
  const view = tgLiveViews.get(key);
  if (view) {
    clearInterval(view.timer);
    tgLiveViews.delete(key);
    return true;
  }
  return false;
}

async function startTgLive(token, chatId, id) {
  const controller = controllers.get(id);
  if (!controller || !controller.page) {
    await tgSend(token, chatId, `La cuenta *${id}* no tiene el navegador abierto. Pulsa ▶️ primero.`);
    return;
  }
  stopTgLive(chatId, id);
  const key = `${chatId}:${id}`;
  let messageId = null;

  const tick = async () => {
    try {
      const c = controllers.get(id);
      if (!c || !c.page) { stopTgLive(chatId, id); return; }
      const buf = Buffer.from(await c.page.screenshot({ encoding: 'base64' }), 'base64');
      if (!messageId) {
        const { boundary, body } = buildMultipart({ chat_id: String(chatId), caption: `📺 Vista en vivo: ${id}` }, 'photo', 'v.png', buf, 'image/png');
        const r = await undiciFetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
        const d = await r.json().catch(() => ({}));
        if (d.ok && d.result) messageId = d.result.message_id;
      } else {
        const media = JSON.stringify({ type: 'photo', media: 'attach://photo' });
        const { boundary, body } = buildMultipart({ chat_id: String(chatId), message_id: String(messageId), media }, 'photo', 'v.png', buf, 'image/png');
        await undiciFetch(`https://api.telegram.org/bot${token}/editMessageMedia`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
      }
    } catch (_) {}
  };

  await tick();
  const timer = setInterval(tick, 5000);
  tgLiveViews.set(key, { timer });
  // Se detiene solo a los 5 minutos (para no dejarlo infinito)
  setTimeout(() => stopTgLive(chatId, id), 5 * 60 * 1000);
}

// Los nombres de cuenta pueden tener espacios ("Mega Oreja"): los detectamos por la lista real.
function tgKnownIds() {
  return [...controllers.keys()].sort((a, b) => b.length - a.length);
}

function tgParseIdAfter(raw, cmd) {
  const m = raw.match(new RegExp(`^/${cmd}\\s+([\\s\\S]+)$`, 'i'));
  if (!m) return null;
  const rest = m[1].trim();
  for (const id of tgKnownIds()) {
    if (rest.toLowerCase() === id.toLowerCase() || rest.toLowerCase().startsWith(`${id.toLowerCase()} `)) return id;
  }
  return rest.split(/\s+/)[0];
}

function tgParseVer(raw) {
  return tgParseIdAfter(raw, 'ver');
}

function tgParseSet(raw) {
  const m = raw.match(/^\/set\s+([\s\S]+)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  for (const id of tgKnownIds()) {
    if (rest.toLowerCase().startsWith(`${id.toLowerCase()} `)) {
      const after = rest.slice(id.length).trim();
      const fm = after.match(/^(\S+)\s+([\s\S]*)$/);
      if (fm) return { id, field: fm[1], value: fm[2].trim() };
    }
  }
  const fm = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]*)$/);
  if (fm) return { id: fm[1], field: fm[2], value: fm[3].trim() };
  return null;
}

function tgMask(value) {
  const v = String(value || '');
  if (v.length <= 6) return v ? '••••' : '(vacío)';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function tgView(id) {
  const config = loadConfig();
  const p = config.find((x) => x.id === id);
  if (!p) return `No encontré la cuenta "${id}".`;
  const d = p.adDetails || {};
  const texto = String(d.text || '');
  return [
    `*Cuenta:* ${p.id}`,
    `Nombre: ${d.name || '-'}`,
    `Título: ${d.headline || '-'}`,
    `Ciudad: ${d.city || '-'}`,
    `Edad: ${d.age || '-'}`,
    `Ubicación: ${d.location || '-'}`,
    `Teléfono: ${d.phone || '-'}`,
    `Texto: ${texto ? texto.slice(0, 300) + (texto.length > 300 ? '…' : '') : '-'}`,
    `Fotos: ${d.photosPath || '-'}`,
    `Proxy: ${p.proxy ? `${p.proxy.host}:${p.proxy.port}` : '-'}`,
    `Email: ${p.email || '-'}`,
    `API 2Captcha: ${tgMask(p.apiKey2Captcha)}`,
    `Password: ${tgMask(p.password)}`,
    '',
    'Editar: `/set ' + p.id + ' campo valor`',
    'Campos: nombre, titulo, ciudad, edad, ubicacion, telefono, texto, fotos, email, password, apikey, proxy'
  ].join('\n');
}

function tgSetField(id, field, value) {
  const key = String(field || '').toLowerCase();
  const pathKey = TG_FIELDS[key];
  if (!pathKey) return `Campo desconocido: "${field}". Usa /ver ${id} para ver los campos.`;
  const config = loadConfig();
  const p = config.find((x) => x.id === id);
  if (!p) return `No encontré la cuenta "${id}".`;

  if (pathKey === 'proxy') {
    const parsed = parseProxy(value);
    if (!parsed) return 'Proxy inválido. Formato: host:puerto:usuario:contraseña';
    p.proxy = parsed;
  } else if (pathKey.startsWith('adDetails.')) {
    const fieldName = pathKey.split('.')[1];
    if (!p.adDetails) p.adDetails = {};
    p.adDetails[fieldName] = String(value);
  } else {
    p[pathKey] = String(value);
  }

  saveConfig(config);
  const controller = controllers.get(id);
  if (controller) controller.cfg = p;
  return `✅ ${id}: ${key} actualizado.`;
}

async function showAccountsMenu(token, chatId, messageId) {
  const payload = {
    chat_id: chatId,
    text: accountsText(),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: accountsKeyboard()
  };
  if (messageId) {
    const r = await tgCall(token, 'editMessageText', { ...payload, message_id: messageId });
    if (r && r.ok === false) await tgCall(token, 'sendMessage', payload);
  } else {
    await tgCall(token, 'sendMessage', payload);
  }
}

async function handleTgCallback(token, query) {
  const data = String(query.data || '');
  const [action, id] = data.split(':');
  const controller = id ? controllers.get(id) : null;
  let aviso = '';
  try {
    if (action === 'view') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id });
      await tgSend(token, query.message.chat.id, tgView(id));
      return;
    }
    if (action === 'panel') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Generando captura...' });
      await tgSendPanelScreenshot(token, query.message.chat.id);
      return;
    }
    if (action === 'live') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Abriendo vista en vivo...' });
      await startTgLive(token, query.message.chat.id, id);
      return;
    }
    if (action === 'stoplive') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Deteniendo vista...' });
      stopTgLive(query.message.chat.id, id);
      return;
    }
    if (action === 'all' && id === 'start') { for (const c of controllers.values()) c.start(); aviso = 'Iniciando todas...'; }
    else if (action === 'all' && id === 'pause') { for (const c of controllers.values()) c.pause(); aviso = 'Pausando todas...'; }
    else if (action === 'all' && id === 'stop') { for (const c of controllers.values()) c.stop(); aviso = 'Deteniendo todas...'; }
    else if (controller && action === 'start') { controller.start(); aviso = `${id}: iniciando...`; }
    else if (controller && action === 'pause') { if (controller.paused) controller.resume(); else controller.pause(); aviso = `${id}: ${controller.paused ? 'pausado' : 'reanudado'}`; }
    else if (controller && action === 'stop') { controller.stop(); aviso = `${id}: detenido`; }
    else if (controller && action === 'publish') { controller.publishNow(); aviso = `${id}: publicando...`; }
  } catch (error) {
    aviso = `Error: ${error.message}`;
  }
  await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: aviso || 'ok' });
  await showAccountsMenu(token, query.message.chat.id, query.message.message_id);
}

let _tgPolling = false;
async function startTelegramBot() {
  if (_tgPolling) return;
  _tgPolling = true;
  let offset = 0;
  while (true) {
    const { token, chatId } = tgConfig();
    if (!token) { await sleep(5000); continue; }
    try {
      const r = await undiciFetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, { signal: AbortSignal.timeout(35000) });
      const data = await r.json();
      if (data && data.ok) {
        for (const u of data.result || []) {
          offset = u.update_id + 1;
          const fromChat = String((u.message && u.message.chat.id) || (u.callback_query && u.callback_query.message.chat.id) || '');
          if (chatId && fromChat !== chatId) continue; // solo el dueño
          if (u.message) {
            const raw = String(u.message.text || '').trim();
            const text = raw.toLowerCase();
            const chat = u.message.chat.id;
            const verId = /^\/ver\s+/i.test(raw) ? tgParseVer(raw) : null;
            const setCmd = /^\/set\s+/i.test(raw) ? tgParseSet(raw) : null;
            if (text === '/start' || text === '/menu' || text === '/cuentas' || text === '/estado') {
              console.log('[telegram] menú enviado a', fromChat);
              await showAccountsMenu(token, chat);
            } else if (text === '/panel' || text === '/captura' || text === '/pantalla') {
              console.log('[telegram] captura del panel');
              await tgSend(token, chat, '🖼 Generando captura del panel...');
              await tgSendPanelScreenshot(token, chat);
            } else if (/^\/vivo\s+/i.test(raw)) {
              const liveId = tgParseIdAfter(raw, 'vivo');
              console.log('[telegram] /vivo', liveId);
              await startTgLive(token, chat, liveId);
            } else if (text === '/parar') {
              let stopped = 0;
              for (const k of [...tgLiveViews.keys()]) {
                const [c, i] = k.split(':');
                if (c === String(chat)) { stopTgLive(c, i); stopped += 1; }
              }
              await tgSend(token, chat, stopped ? '⏹ Vista en vivo detenida.' : 'No había vista en vivo activa.');
            } else if (verId) {
              console.log('[telegram] /ver', verId);
              await tgSend(token, chat, tgView(verId));
            } else if (setCmd) {
              console.log('[telegram] /set', setCmd.id, setCmd.field);
              await tgSend(token, chat, tgSetField(setCmd.id, setCmd.field, setCmd.value));
            } else if (text === '/ayuda' || text === '/help') {
              await tgSend(token, chat, '*Comandos*\n/menu — cuentas y botones\n/ver <id> — ver una cuenta completa\n/set <id> <campo> <valor> — editar un campo\n/vivo <id> — vista en vivo (foto que se refresca)\n/parar — detener la vista en vivo\n/panel — captura del panel completo\n\nCampos: nombre, titulo, ciudad, edad, ubicacion, telefono, texto, fotos, email, password, apikey, proxy');
            }
          } else if (u.callback_query) {
            console.log('[telegram] botón:', u.callback_query.data);
            await handleTgCallback(token, u.callback_query);
          }
        }
      }
    } catch (_) {}
    await sleep(2000);
  }
}

async function validateProxy(proxy, timeoutMs = 15000) {
  if (!proxy || !proxy.host) return { skipped: true };

  const dispatcher = buildProxyDispatcher(proxy);
  if (!dispatcher) return { skipped: true };

  try {
    const res = await undiciFetch('https://api.ipify.org?format=json', {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, ip: data.ip };
  } catch (error) {
    return { ok: false, reason: error.message };
  } finally {
    await dispatcher.close().catch(() => {});
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveState() {
  try {
    const state = {};
    for (const [id, controller] of controllers.entries()) {
      state[id] = {
        active: Boolean(controller.started),
        stats: controller.stats,
        cycleStage: controller.cycleStage,
        cycleDetail: controller.cycleDetail,
        cycleUpdatedAt: controller.cycleUpdatedAt,
        cycleDeleteCompleted: Boolean(controller.cycleDeleteCompleted),
        rotateQueue: Array.isArray(controller.rotateQueue) ? controller.rotateQueue : [],
        variantIndex: controller.variantIndex || {}
      };
    }
    backupFile(STATE_PATH, 'state');
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.error('No se pudo guardar state.json:', error.message);
  }
}

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function hhmmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function killChromeForProfileDir(profileDir) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profileDir}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, () => resolve());
    } else {
      execFile('pkill', ['-f', profileDir], () => resolve());
    }
  });
}

// Cierra una instancia previa de Chrome que esté bloqueando la carpeta del perfil
async function closeStaleChrome(profileDir, port, log = () => {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      log(`🔌 Cerrando Chrome previo en el puerto ${port}...`);
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
      await browser.close().catch(() => {});
      await sleep(1500);
    }
  } catch (_) {
    // El puerto no responde: se cierra por proceso.
  }

  await killChromeForProfileDir(profileDir);
  await sleep(1500);
}

function isProfileLockError(message) {
  return /already running|userDataDir|SingletonLock|profile appears to be in use|ProcessSingleton/i.test(String(message || ''));
}

function waitForAnySelector(page, selectors, timeout = 8000) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      for (const selector of list) {
        try {
          await page.waitForSelector(selector, { timeout: 1200 });
          resolve(selector);
          return;
        } catch (_) {
          // intentar siguiente selector
        }
      }
      if (Date.now() - start >= timeout) {
        resolve(null);
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

async function detectCaptchaSiteKey(page) {
  return page.evaluate(() => {
    const byAttr = document.querySelector('[data-sitekey]');
    if (byAttr && byAttr.getAttribute('data-sitekey')) {
      return byAttr.getAttribute('data-sitekey');
    }

    const iframe = document.querySelector('iframe[src*="recaptcha"][src*="k="]');
    if (iframe) {
      const match = iframe.getAttribute('src').match(/[?&]k=([^&]+)/);
      if (match) return decodeURIComponent(match[1]);
    }

    try {
      const cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        for (const key of Object.keys(cfg.clients)) {
          const stack = [cfg.clients[key]];
          const seen = new Set();
          while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node);
            if (typeof node.sitekey === 'string' && node.sitekey.length > 20) {
              return node.sitekey;
            }
            for (const value of Object.values(node)) {
              if (value && typeof value === 'object') stack.push(value);
            }
          }
        }
      }
    } catch (_) {
      // sin sitekey accesible
    }

    return null;
  });
}

// fetch a 2Captcha con timeout para que nunca se quede colgado
function twoCaptchaFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
}

// Función para resolver CAPTCHAs automáticamente con tu clave de 2Captcha
async function solveCaptcha(apiKey, siteKey, pageUrl, page) {
  try {
    console.log('🤖 Enviando CAPTCHA a 2Captcha...');
    const submitRes = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      throw new Error(`Error al enviar: ${submitData.request}`);
    }

    const taskId = submitData.request;
    console.log(`⏳ Tarea creada (${taskId}). Esperando resolución de 2Captcha...`);

    for (let i = 0; i < 60; i++) {
      await sleep(5000);

      const res = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
      const data = await res.json();

      if (data.status === 1) {
        const token = data.request;
        console.log('✅ ¡CAPTCHA resuelto con éxito! Inyectando token...');

        await page.evaluate((tokenVal) => {
          const fields = document.querySelectorAll(
            'textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"], [id*="g-recaptcha-response"]'
          );
          fields.forEach((field) => {
            field.value = tokenVal;
            field.innerHTML = tokenVal;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
          });

          try {
            const cfg = window.___grecaptcha_cfg;
            if (cfg && cfg.clients) {
              for (const key of Object.keys(cfg.clients)) {
                const stack = [cfg.clients[key]];
                const seen = new Set();
                while (stack.length) {
                  const node = stack.pop();
                  if (!node || typeof node !== 'object' || seen.has(node)) continue;
                  seen.add(node);
                  if (typeof node.callback === 'function') {
                    try { node.callback(tokenVal); } catch (_) {}
                  }
                  for (const value of Object.values(node)) {
                    if (value && typeof value === 'object') stack.push(value);
                  }
                }
              }
            }
          } catch (_) {
            // sin callback accesible
          }
        }, token);

        twoCaptchaStats.solves += 1;
        return true;
      }

      if (data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`Respuesta de error: ${data.request}`);
      }
    }

    throw new Error('Tiempo de espera agotado para el CAPTCHA.');
  } catch (error) {
    twoCaptchaStats.fails += 1;
    console.error(`❌ Error en resolución automática: ${error.message}`);
    return false;
  }
}

const CAPTCHA_INPUT_SELECTORS = [
  '#captcha_code',
  'input[name="captchaCode"]',
  '[data-momonga-captcha-input]',
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
  'input[placeholder*="picture" i]',
  'input[placeholder*="code from" i]',
  'input[autocapitalize="characters"]'
];

async function markImageCaptcha(page) {
  for (const frame of page.frames()) {
    const marked = await frame.evaluate((inputSelectors) => {
      const bySelector = document.querySelector(inputSelectors.join(', '));
      const fields = Array.from(document.querySelectorAll('input, textarea'));
      // El campo real de MegaPersonals es #captcha_code: forzarlo antes que cualquier heurística.
      const input = document.getElementById('captcha_code')
        || bySelector
        || fields.find((item) => /captcha|code from|picture|verification/i.test(`${item.name || ''} ${item.id || ''} ${item.placeholder || ''}`))
        || fields.find((item) => item.type === 'text' && !/email/i.test(`${item.name || ''} ${item.id || ''}`));
      if (!input) return false;

      const known = document.getElementById('captcha_image_itself');
      const elements = Array.from(document.querySelectorAll('img, canvas'));
      const visible = elements.filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 10);
      const byName = visible.find((el) => /captcha|verif|code/i.test(`${el.src || ''} ${el.id || ''} ${el.className || ''} ${el.alt || ''}`));
      const bySize = visible.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width >= 40 && rect.width <= 420 && rect.height >= 20 && rect.height <= 160;
      });
      const image = (known && known.offsetParent !== null ? known : null) || byName || bySize;
      if (!image) return false;

      image.setAttribute('data-momonga-captcha-image', '1');
      input.setAttribute('data-momonga-captcha-input', '1');
      return true;
    }, CAPTCHA_INPUT_SELECTORS).catch(() => false);
    if (marked) return true;
  }
  return false;
}

async function findInFrames(page, selector) {
  for (const frame of page.frames()) {
    const handle = await frame.$(selector).catch(() => null);
    if (handle) return handle;
  }
  return null;
}

// Escribe el código en el campo del captcha buscándolo en todos los frames y verificando que quedó
async function fillCaptchaInput(page, code, controller) {
  const selector = CAPTCHA_INPUT_SELECTORS.join(', ');
  const log = (msg) => { if (controller) controller.log(msg); };

  for (const frame of page.frames()) {
    let handle = await frame.$('#captcha_code').catch(() => null);
    if (!handle) handle = await frame.$(selector).catch(() => null);
    if (!handle) continue;

    const checkValue = () => handle.evaluate((el, val) => String(el.value || '').trim() === val, code).catch(() => false);

    // 1) Igual que el otro proyecto que funciona: teclado real (clear + send_keys).
    try {
      await handle.evaluate((el) => { try { el.scrollIntoView({ block: 'center' }); } catch (_) {} el.focus(); }).catch(() => {});
      await handle.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.down('Control').catch(() => {});
      await page.keyboard.press('KeyA').catch(() => {});
      await page.keyboard.up('Control').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await handle.type(code, { delay: 60 }).catch(() => {});
      await sleep(300);
      if (await checkValue()) return true;
    } catch (_) {
      // seguir con el respaldo
    }

    // 2) Respaldo: asignar el valor directamente.
    const set = await frame.evaluate((sel, val) => {
      const input = document.querySelector(sel);
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(input.__proto__, 'value')?.set;
      if (setter) setter.call(input, val); else input.value = val;
      input.setAttribute('value', val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }, selector, code).catch(() => false);

    if (set) {
      await sleep(300);
      if (await checkValue()) return true;
    }
  }

  log('⚠️ No se encontró o no quedó escrito el campo del captcha.');
  return false;
}

// Prepara la imagen del captcha. binarize=false solo amplía (más fiel); binarize=true aplica gris+umbral.
async function preprocessCaptchaImage(page, pngBase64, binarize = false) {
  return page.evaluate(async (dataUrl, doBinarize) => {
    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const scale = 3;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-momonga-skip', '1');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (doBinarize) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const value = avg < 140 ? 0 : 255;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
      }
      ctx.putImageData(imageData, 0, 0);
    }
    return canvas.toDataURL('image/png').replace(/^data:image\/\w+;base64,/, '');
  }, `data:image/png;base64,${pngBase64}`, binarize).catch(() => null);
}

async function reloadImageCaptcha(page) {
  await page.evaluate(() => {
    const reload = document.getElementById('captchaReloadButton')
      || Array.from(document.querySelectorAll('img')).find((el) => /reload|refresh/i.test(`${el.src || ''} ${el.id || ''} ${el.className || ''}`));
    if (reload) reload.click();
  }).catch(() => {});
}

// Resuelve CAPTCHAs de imagen (los que no son reCAPTCHA) con 2Captcha
async function solveImageCaptcha(apiKey, page, controller) {
  if (!(await markImageCaptcha(page))) return false;

  const imageHandle = await findInFrames(page, '[data-momonga-captcha-image]');
  if (!imageHandle) return false;

  const rawShot = await imageHandle.screenshot({ encoding: 'base64' }).catch(async () => {
    const box = await imageHandle.boundingBox();
    if (!box || !box.width || !box.height) return null;
    return page.screenshot({ clip: box, encoding: 'base64' });
  });
  if (!rawShot) return false;

  const binarized = await preprocessCaptchaImage(page, rawShot, true);

  // Igual que el otro proyecto que funciona: 1º la imagen CRUDA tal cual (sin procesar).
  // Si 2Captcha no la resuelve en 60s, 2º intento con la binarizada.
  const attempts = [
    { label: 'original', image: rawShot },
    { label: 'binarizada', image: binarized }
  ].filter((a) => a.image);

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const code = await submitAndPollImage(apiKey, attempt.image, controller, 60000, attempt.label);
      const filled = await fillCaptchaInput(page, code, controller);
      if (!filled) {
        throw new Error('2Captcha resolvió el código, pero no se pudo escribir en el campo del captcha.');
      }
      return code;
    } catch (error) {
      lastError = error;
      controller.log(`⚠️ Intento de captcha (${attempt.label}) falló: ${error.message}`);
    }
  }

  throw lastError || new Error('No se pudo resolver el CAPTCHA de imagen.');
}

async function submitAndPollImage(apiKey, imageBase64, controller, timeoutMs, label) {
  controller.log(`🤖 Enviando CAPTCHA de imagen a 2Captcha (${label})...`);
  const submitRes = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/in.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: apiKey, method: 'base64', body: imageBase64, json: '1' })
  });
  const submitData = await submitRes.json();
  if (submitData.status !== 1) {
    throw new Error(`Error al enviar imagen: ${submitData.request}`);
  }

  const taskId = submitData.request;
  controller.log(`⏳ Tarea de imagen creada (${taskId}). Esperando resolución (máx. ${Math.round(timeoutMs / 1000)}s)...`);

  const startedAt = Date.now();
  let polls = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(2000);
    polls += 1;
    const res = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
    const data = await res.json();
    if (data.status === 1) {
      twoCaptchaStats.solves += 1;
      return String(data.request || '').trim().toUpperCase();
    }
    if (data.request !== 'CAPCHA_NOT_READY') {
      twoCaptchaStats.fails += 1;
      throw new Error(`2Captcha: ${data.request}`);
    }
    if (polls % 10 === 0) {
      controller.log(`⏳ Aún esperando a 2Captcha (${label})... (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
  }

  twoCaptchaStats.fails += 1;
  throw new Error(`2Captcha no resolvió la imagen (${label}) en ${Math.round(timeoutMs / 1000)}s.`);
}

async function handleCaptchaIfPresent(page, controller) {
  const apiKey = controller.cfg.apiKey2Captcha;
  const hasApiKey = Boolean(apiKey) && !/^AQU[IÍ]/i.test(apiKey);
  const siteKey = await detectCaptchaSiteKey(page);

  if (siteKey) {
    if (!hasApiKey) {
      controller.log('CAPTCHA detectado pero falta la clave apiKey2Captcha del perfil en la configuración.');
      return false;
    }
    controller.log('🧩 CAPTCHA reCAPTCHA detectado. Resolviendo con 2Captcha...');
    const solved = await solveCaptcha(apiKey, siteKey, page.url(), page);
    controller.log(solved ? '✅ CAPTCHA resuelto e inyectado.' : '❌ No se pudo resolver el CAPTCHA.');
    return solved;
  }

  if (!hasApiKey) return true;

  try {
    const code = await solveImageCaptcha(apiKey, page, controller);
    if (code) {
      controller.log(`✅ CAPTCHA de imagen resuelto e introducido: "${code}".`);
      return true;
    }
  } catch (error) {
    controller.log(`❌ No se pudo resolver el CAPTCHA de imagen: ${error.message}`);
  }

  return true;
}

const BLOCK_PATTERNS = [
  /account[^.]{0,40}(suspended|banned|blocked|disabled|deactivated|locked|restricted)/i,
  /(suspended|banned|blocked|disabled|deactivated|locked|restricted)[^.]{0,40}account/i,
  /access denied/i,
  /cuenta\s+(suspendida|bloqueada|baneada|desactivada|restringida|cerrada)/i,
  /your account (has been|was|is) (suspended|banned|blocked|disabled|deactivated|locked|restricted|under review)/i,
  /you (have been|are) (suspended|banned|blocked|restricted)/i,
  /(disabled|deactivated|locked|restricted) (your )?account/i,
  /permanently (banned|suspended|blocked)/i,
  /violat(e|ion|ed)[^.]{0,40}(terms|policy|policies)/i,
  /has sido (suspendido|bloqueado|baneado)/i,
  /su cuenta (ha sido|fue) (suspendida|bloqueada|baneada|desactivada)/i,
  // Página "scam-page" de MegaPersonals (bloqueo de la cuenta)
  /fraud bots? (have|has) been triggered/i,
  /you may have been\s*phished/i,
  /phished by a\s*scammer/i,
  /i (don'?t|do not) know why i am blocked/i,
  /\bscam-page\b/i
];

let emergencyActive = false;

async function detectBlock(page) {
  try {
    const url = page.url();
    // Verificacion de dispositivo / login / captcha: NO es bloqueo de cuenta
    if (/device-verification|\/users\/verify\b|\/verify\/\d+|\/captcha\b|challenge|\/login\b|sign.?in/i.test(url)) return false;
    if (/\/users\/ban_message|\bban_message\b|\/banned\b|\/suspended\b/i.test(url)) return true;

    return await page.evaluate((patternsSource) => {
      // Marcadores fuertes del bloqueo de MegaPersonals (página "scam-page")
      if (document.querySelector('.scam-page, .banned-message-small, img[src*="banned"], a[href*="scam_request"]')) return true;

      const patterns = patternsSource.map((source) => new RegExp(source, 'i'));
      const parts = [document.title || '', window.location.href || ''];

      const selectors = [
        'h1', 'h2', 'h3',
        '[role="alert"]',
        '.alert', '.error', '.error-message', '.notice-error',
        '.scam-page', '.banned-message-small',
        '[class*="alert" i]', '[class*="error" i]', '[class*="suspend" i]', '[class*="banned" i]', '[class*="blocked" i]',
        '[class*="restrict" i]', '[class*="deactivat" i]', '[class*="denied" i]', '[class*="scam" i]',
        '[id*="alert" i]', '[id*="error" i]', '[id*="suspend" i]', '[id*="banned" i]', '[id*="blocked" i]'
      ];

      document.querySelectorAll(selectors.join(',')).forEach((el) => {
        if (el && el.innerText) parts.push(el.innerText);
      });

      const haystack = parts.join('\n');
      return patterns.some((re) => re.test(haystack));
    }, BLOCK_PATTERNS.map((re) => re.source));
  } catch (_) {
    return false;
  }
}

async function emergencyStop(reason, sourceId) {
  if (emergencyActive) return;
  emergencyActive = true;

  const active = [...controllers.values()].filter((c) => c.started);

  console.error('');
  console.error('\x1b[43m\x1b[1m\x1b[37m' + ' ⏸  PAUSA DE SEGURIDAD  ⏸ ' + '\x1b[0m');
  console.error(`⏸ Bloqueo/verificación detectado${sourceId ? ` en "${sourceId}"` : ''}: ${reason}`);
  console.error(`⏸ Pausando ${active.length} perfil(es). Los navegadores siguen ABIERTOS (no se cierran) para verificación/apelación.`);
  console.error('');

  io.emit('emergency-stop', { reason, sourceId, at: Date.now() });
  notify(`⏸ PAUSA DE SEGURIDAD${sourceId ? ` en "${sourceId}"` : ''}: ${reason}. ${active.length} perfil(es) pausados (navegadores abiertos).`);

  for (const controller of active) {
    controller.log(`⏸ PAUSA DE SEGURIDAD: ${reason} Se pausan los perfiles (el navegador queda abierto).`);
  }

  for (const controller of active) {
    try { controller.pause(); } catch (_) {}
  }

  emergencyActive = false;
}

async function captureBlockEvidence(page, controller, reason) {
  try {
    fs.mkdirSync(APPEALS_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const id = `${controller.id}-${stamp}`;
    const pngName = `${id}.png`;
    const htmlName = `${id}.html`;

    let url = '';
    let message = '';
    try {
      url = page.url();
      message = await page.evaluate(() => {
        const selectors = ['h1', 'h2', 'h3', '[role="alert"]', '.alert', '.error', '[class*="error" i]', '[class*="alert" i]', '[class*="suspend" i]', '[class*="blocked" i]'];
        const parts = [];
        document.querySelectorAll(selectors.join(',')).forEach((el) => {
          if (el && el.innerText) parts.push(el.innerText.replace(/\s+/g, ' ').trim());
        });
        return parts.join(' | ').slice(0, 500);
      }).catch(() => '');
    } catch (_) {}

    try { await page.screenshot({ path: path.join(APPEALS_DIR, pngName) }); } catch (_) {}
    try { fs.writeFileSync(path.join(APPEALS_DIR, htmlName), await page.content(), 'utf8'); } catch (_) {}

    const record = {
      id,
      profile: controller.id,
      account: controller.cfg.email || '',
      reason,
      message,
      url,
      siteUrl: controller.cfg.url || DEFAULT_URL,
      supportUrl: controller.cfg.supportUrl || '',
      supportEmail: controller.cfg.supportEmail || DEFAULT_SUPPORT_EMAIL,
      stage: controller.cycleStage,
      detail: controller.cycleDetail,
      at: now.toISOString(),
      screenshot: pngName,
      html: htmlName
    };

    const indexPath = path.join(APPEALS_DIR, 'index.json');
    let index = [];
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(index)) index = [];
    } catch (_) {}
    index.push(record);
    fs.writeFileSync(indexPath, `${JSON.stringify(index.slice(-200), null, 2)}\n`, 'utf8');

    controller.log(`📸 Evidencia del bloqueo guardada en logs/appeals/${pngName}`);
    io.emit('block-evidence', record);

    if (controller.cfg.autoAppeal !== false) {
      const { outlookUrl } = buildAppealDraft(record);
      if (outlookUrl) {
        controller.log(`📧 Abriendo el correo para apelar a ${record.supportEmail}...`);
        const ok = await openUrlInProfileBrowser(controller, outlookUrl);
        if (ok) controller.log('📧 Correo abierto en el navegador del perfil.');
        else openExternalUrl(outlookUrl);
      }
    }

    return record;
  } catch (error) {
    try { controller.log(`No se pudo guardar la evidencia del bloqueo: ${error.message}`); } catch (_) {}
    return null;
  }
}

function openExternalUrl(url) {
  try {
    if (!url) return;
    if (process.env.MOMONGA_NO_OPEN === '1') {
      console.log('[open-external omitido]', url.slice(0, 120));
      return;
    }
    if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
    } else {
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { windowsHide: true }, () => {});
    }
  } catch (_) {
    // si no se puede abrir, se ignora
  }
}

// Abre una URL en el navegador YA ABIERTO de un perfil (misma ventana, proxy y sesion).
// Devuelve false si ese navegador no esta abierto (para que el caller use el navegador por defecto).
async function openUrlInProfileBrowser(controller, url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (!controller || !controller.browser) return false;
  try {
    const page = await controller.browser.newPage();
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

function buildAppealDraft(record) {
  const account = (record && record.account) || '(tu correo)';
  const supportEmail = (record && record.supportEmail) || DEFAULT_SUPPORT_EMAIL;
  const when = record && record.at ? new Date(record.at).toUTCString() : '';
  let supportUrl = (record && record.supportUrl) || '';
  if (!supportUrl && record && record.siteUrl) {
    try { supportUrl = `${new URL(record.siteUrl).origin}/contact`; } catch (_) { supportUrl = record.siteUrl; }
  }

  const subject = 'Appeal - account suspended / blocked';
  const body = [
    'Hello,',
    '',
    `My account (${account}) appears to have been suspended or blocked. I believe this may be a mistake or the result of a false report, and I am requesting a manual review.`,
    '',
    'Details:',
    `- Account: ${account}`,
    `- Profile: ${(record && record.profile) || ''}`,
    `- Date: ${when}`,
    `- Page: ${(record && record.url) || ''}`,
    `- Detected message: ${(record && (record.message || record.reason)) || ''}`,
    '',
    'I have always followed the platform terms of service. Please review my account and restore it if possible.',
    '',
    'Thank you,'
  ].join('\n');

  const draft = `Subject: ${subject}\n\n${body}`;
  const enc = encodeURIComponent;
  const outlookUrl = supportEmail
    ? `https://outlook.live.com/mail/0/deeplink/compose?to=${enc(supportEmail)}&subject=${enc(subject)}&body=${enc(body)}`
    : '';
  const mailtoUrl = supportEmail
    ? `mailto:${enc(supportEmail)}?subject=${enc(subject)}&body=${enc(body)}`
    : '';

  return { draft, subject, body, supportUrl, supportEmail, outlookUrl, mailtoUrl };
}

// Apelación manual desde el panel (sin captura, por si no se detectó el bloqueo)
async function createManualAppeal(controller, reason = 'Apelación manual desde el panel.') {
  try {
    fs.mkdirSync(APPEALS_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const id = `${controller.id}-${stamp}`;
    const record = {
      id,
      profile: controller.id,
      account: controller.cfg.email || controller.id,
      reason,
      message: reason,
      url: controller.page ? controller.page.url() : '',
      siteUrl: controller.cfg.url || DEFAULT_URL,
      supportUrl: controller.cfg.supportUrl || '',
      supportEmail: controller.cfg.supportEmail || DEFAULT_SUPPORT_EMAIL,
      stage: controller.cycleStage,
      detail: controller.cycleDetail,
      at: now.toISOString(),
      screenshot: '',
      html: ''
    };
    const indexPath = path.join(APPEALS_DIR, 'index.json');
    let index = [];
    try {
      index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!Array.isArray(index)) index = [];
    } catch (_) {}
    index.push(record);
    fs.writeFileSync(indexPath, `${JSON.stringify(index.slice(-200), null, 2)}\n`, 'utf8');
    const { outlookUrl } = buildAppealDraft(record);
    if (outlookUrl && controller.cfg.autoAppeal !== false) {
      controller.log(`📧 Abriendo el correo para apelar a ${record.supportEmail}...`);
      const ok = await openUrlInProfileBrowser(controller, outlookUrl);
      if (ok) controller.log('📧 Correo abierto en el navegador del perfil.');
      else openExternalUrl(outlookUrl);
    }
    controller.log('📨 Apelación manual creada (revisa "Bloqueos detectados").');
    io.emit('block-evidence', record);
    return record;
  } catch (error) {
    try { controller.log(`No se pudo crear la apelación: ${error.message}`); } catch (_) {}
    return null;
  }
}

async function isLoginPage(page) {
  try {
    return await page.evaluate(() => {
      const hasLoginFields = Boolean(document.querySelector('input[type="password"], input[type="email"]'));
      if (!hasLoginFields) return false;
      const url = window.location.href;
      const text = document.body ? document.body.innerText : '';
      return /login|sign in|session expired|sesi[oó]n|inicia(r)? sesi[oó]n/i.test(text)
        || /\/login|reset_user_password|\/users\/login|\/users\/sign/i.test(url);
    });
  } catch (_) {
    return false;
  }
}

async function isVerificationPage(page) {
  try {
    return await page.evaluate(() => /device-verification|\/users\/verify\b|\/verify\/\d+/i.test(window.location.href));
  } catch (_) {
    return false;
  }
}

async function checkForBlock(page, controller, opts = {}) {
  // Sesión caducada (página de login) NO es un bloqueo: nunca parar las demás cuentas.
  if (!opts.skipLoginCheck && controller && await isLoginPage(page)) {
    if (await ensureSession(page, controller)) {
      controller.log('♻️ Sesión renovada tras el login (no era bloqueo).');
    } else {
      controller.warn('⚠️ Sesión caducada sin credenciales: se PAUSA solo este perfil (no es bloqueo).');
      controller.pause();
    }
    return true;
  }

  // Verificación de dispositivo (device-verification): NO es bloqueo → pausar solo este perfil.
  if (!opts.skipLoginCheck && controller && await isVerificationPage(page)) {
    controller.warn('🔐 Verificación de dispositivo requerida: se PAUSA solo este perfil (no es bloqueo). Revísalo en este navegador y vuelve a Iniciar.');
    controller.pause();
    return true;
  }

  // HTTP 403/429/5xx en el documento principal, aunque el texto no lo diga
  if (controller && controller._httpBlock && Date.now() - controller._httpBlock.at < 60000) {
    const { status, url } = controller._httpBlock;
    controller._httpBlock = null;

    // 429 (rate-limit) y 5xx: esperar y reintentar; solo parar todo si se repite.
    if (status === 429 || status >= 500) {
      controller._httpRateCount = (controller._httpRateCount || 0) + 1;
      if (controller._httpRateCount >= 3) {
        await captureBlockEvidence(page, controller, `HTTP ${status} repetido (${controller._httpRateCount} veces) en ${url}`);
        await emergencyStop(`HTTP ${status} repetido (posible rate-limit/bloqueo).`, controller.id);
        return true;
      }
      controller.warn(`HTTP ${status} (rate-limit): espero y reintento el próximo ciclo (sin detener todo).`);
      return true;
    }

    // 403 u otros: si la URL es de verificacion/login/captcha, NO es bloqueo -> pausar solo este perfil
    if (/device-verification|\/users\/verify\b|\/verify\/\d+|\/captcha\b|challenge|\/login\b|sign.?in/i.test(url)) {
      controller.warn(`🔐 HTTP ${status} en página de verificación: se PAUSA solo este perfil (no es bloqueo).`);
      controller.pause();
      return true;
    }
    // bloqueo de la cuenta
    await captureBlockEvidence(page, controller, `HTTP ${status} (bloqueo) en ${url}`);
    await emergencyStop(`HTTP ${status} (posible bloqueo).`, controller.id);
    return true;
  }

  if (await detectBlock(page)) {
    await captureBlockEvidence(page, controller, 'La página muestra señales de suspensión/bloqueo.');
    await emergencyStop('La página muestra señales de suspensión/bloqueo.', controller.id);
    return true;
  }
  return false;
}

// --- Cumplimiento: control de riesgo que suele disparar reportes ---
const recentBumpTimes = new Map();
const textHashOwners = new Map();
const photoSetOwners = new Map();

function hashText(text) {
  return crypto.createHash('sha1').update(String(text || '').trim().toLowerCase()).digest('hex');
}

function hashFile(filePath) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null;
  }
}

function hashPhotoSet(photosPath) {
  if (!photosPath) return null;
  try {
    const dir = path.resolve(__dirname, photosPath);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    const hashes = fs.readdirSync(dir)
      .filter((name) => /\.(jpg|jpeg|png|webp)$/i.test(name))
      .map((name) => hashFile(path.join(dir, name)))
      .filter(Boolean)
      .sort();
    return hashes.length ? hashes.join(',') : null;
  } catch (_) {
    return null;
  }
}

function assessComplianceRisk(controller) {
  const reasons = [];
  const details = controller.cfg.adDetails || {};
  const now = Date.now();

  const times = (recentBumpTimes.get(controller.id) || []).filter((t) => now - t < 30 * 60 * 1000);
  recentBumpTimes.set(controller.id, times);
  if (times.length >= 3) {
    reasons.push(`publicaciones muy seguidas (${times.length} en 30 min)`);
  }

  if (details.text && String(details.text).trim()) {
    const textHash = hashText(details.text);
    const owners = textHashOwners.get(textHash) || new Set();
    const others = [...owners].filter((id) => id !== controller.id);
    if (others.length > 0) {
      reasons.push(`texto idéntico al de otra cuenta (${others.join(', ')})`);
    }
    owners.add(controller.id);
    textHashOwners.set(textHash, owners);
  }

  const photoSet = hashPhotoSet(details.photosPath);
  if (photoSet) {
    const owners = photoSetOwners.get(photoSet) || new Set();
    const others = [...owners].filter((id) => id !== controller.id);
    if (others.length > 0) {
      reasons.push(`mismas fotos que otra cuenta (${others.join(', ')})`);
    }
    owners.add(controller.id);
    photoSetOwners.set(photoSet, owners);
  }

  return reasons;
}

// Solo AVISA del riesgo de reportes; NO cambia el intervalo (se respeta el que configures).
function warnComplianceRisk(controller, reasons) {
  controller.log(`⚠️ Cumplimiento: ${reasons.join('; ')}. (Se mantiene el intervalo configurado.)`);
  io.emit('compliance-warning', { id: controller.id, reasons, at: Date.now() });
  return true;
}

async function loginIfNeeded(page, controller) {
  if (!controller.cfg.email || !controller.cfg.password) {
    controller.log('Sin credenciales, se asume sesión ya abierta.');
    return;
  }

  const emailSelectors = [
    '#person_username_field_login',
    'input[name="username"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]'
  ];
  const passSelectors = [
    '#person_password_field_login',
    'input[type="password"]',
    'input[name="password"]'
  ];

  const emailSelector = await waitForAnySelector(page, emailSelectors, 10000);
  const passSelector = await waitForAnySelector(page, passSelectors, 10000);

  if (!emailSelector || !passSelector) {
    controller.log('No se detectaron campos de login.');
    return;
  }

  await page.locator(emailSelector).fill(controller.cfg.email);
  await page.locator(passSelector).fill(controller.cfg.password);

  await handleCaptchaIfPresent(page, controller);

  await page.keyboard.press('Enter');
  controller.log('Login enviado.');

  await sleep(3000);
  await checkForBlock(page, controller);
}

// Revisa si la sesión murió y, si hay credenciales, vuelve a iniciar sesión.
async function ensureSession(page, controller) {
  try {
    const state = await page.evaluate(() => {
      const hasLoginFields = Boolean(document.querySelector('input[type="password"], input[type="email"]'));
      const url = window.location.href;
      const text = document.body ? document.body.innerText : '';
      const loginish = /login|sign in|session expired|sesión/i.test(text) || /\/login|reset_user_password/i.test(url);
      return { hasLoginFields, loginish };
    }).catch(() => ({ hasLoginFields: false, loginish: false }));

    if (state.hasLoginFields && state.loginish) {
      if (!controller.cfg.email || !controller.cfg.password) {
        controller.warn('La sesión se cerró y no hay credenciales guardadas para re-loguear.');
        return false;
      }
      controller.log('🔐 La sesión se cerró; iniciando sesión de nuevo...');
      await loginIfNeeded(page, controller);
      await sleep(2500);
      return true;
    }
  } catch (_) {}
  return false;
}

async function clickBumpButton(page) {
  const findAndClick = () => page.evaluate(() => {
    const visible = (el) => el && el.offsetParent !== null;
    const byId = document.getElementById('managePublishAd');
    if (visible(byId)) {
      byId.click();
      return true;
    }
    const controls = Array.from(document.querySelectorAll('a, button'));
    const el = controls.find((e) => visible(e) && /bump\s*to\s*top|bump|boost|subir/i.test(`${e.innerText || ''} ${e.value || ''} ${e.id || ''} ${e.getAttribute('href') || ''}`));
    if (el) {
      el.click();
      return true;
    }
    return false;
  }).catch(() => false);

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await findAndClick()) return true;
    await sleep(500);
  }
  return false;
}

async function doBump(page, controller) {
  controller.setCycleStage('publishing', 'Buscando el botón de bump.');
  if (!(await clickBumpButton(page))) return false;

  const confirmed = await page.waitForFunction(
    () => window.location.href.includes('success_publish'),
    { timeout: 15000 }
  ).then(() => true).catch(() => false);

  if (!confirmed) {
    if (await checkForBlock(page, controller)) return false;
    controller.setCycleStage('error', 'No se confirmó success_publish.');
    controller.log('⚠️ El botón respondió, pero no se confirmó la publicación en 15 segundos.');
    return false;
  }

  controller.log(`🚀 Bump confirmado (${page.url()}).`);
  controller.setCycleStage('completed', 'Bump confirmado.');
  controller.recordBump();

  // Cerrar el modal "Success!" con OK para poder seguir
  if (await dismissOkModal(page)) await sleep(1200);

  // Igual que la extensión: esperar y volver a la lista de posts.
  await sleep(1500);
  await returnToPostsList(page, controller);
  return true;
}

async function returnToPostsList(page, controller) {
  const urls = siteUrls(controller);
  const currentUrl = page.url();

  if (currentUrl.includes('success_publish')) {
    controller.log('✔ Anuncio republicado correctamente.');
  } else if (currentUrl.includes('error-message')) {
    controller.log('⚠ El anuncio dio error.');
  }

  // 1) Pulsar el botón "My Posts" visible si existe (igual que el flujo de la extensión)
  try {
    const myPostsClicked = await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a.manage-button, a[href*="users/posts/list"]'))
        .find(a => a.offsetParent !== null && (a.innerText || '').trim().toLowerCase().includes('my posts'));
      if (link) {
        link.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (myPostsClicked) {
      controller.log('↩️ Volviendo a Mis Anuncios (My Posts)...');
      await sleep(2000);
      return;
    }
  } catch (_) {}

  // 2) Si ya está en la lista de posts, no hacer nada
  if (currentUrl.includes('/users/posts/list')) {
    return;
  }

  // 3) Igual que la extensión: window.location.href = LISTA_POSTS
  controller.log('Volviendo a Mis Anuncios...');
  try {
    await page.goto(urls.list, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    controller.log(`No se pudo volver a Mis Anuncios: ${error.message}`);
  }
}

async function performBump(page, controller) {
  const urls = siteUrls(controller);
  if (await doBump(page, controller)) return true;

  controller.log('Buscando el anuncio en Mis Anuncios...');
  try {
    await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (error) {
    controller.log(`No se pudo abrir Mis Anuncios: ${error.message}`);
    controller.log('No se encontró botón de bump/publicación.');
    return false;
  }

  if (await checkForBlock(page, controller)) return false;

  if (await doBump(page, controller)) return true;

  controller.log('⚠️ No se encontró el botón Bump to Top. Puede que el anuncio ya esté arriba o no sea elegible para bump.');
  return false;
}

// Bump de todos los anuncios de la cuenta uno por uno (rota en cada ciclo, sin borrar)
async function bumpAllAdsOneByOne(page, controller) {
  const urls = siteUrls(controller);
  controller.setCycleStage('publishing', 'Rotando anuncios de la cuenta.');
  controller.log('🔄 Rotando: abriendo Mis Anuncios...');

  try {
    await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (error) {
    controller.log(`No se pudo abrir Mis Anuncios: ${error.message}`);
    return false;
  }

  if (await checkForBlock(page, controller)) return false;

  const ads = await page.evaluate(() => {
    const seen = new Set();
    const result = [];
    const collect = (selector, re) => {
      for (const link of document.querySelectorAll(selector)) {
        const raw = link.getAttribute('href') || '';
        const match = raw.match(re);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);
        let title = '';
        const container = link.closest('.post_header, .post, li, tr, article, section, div');
        if (container) {
          const node = container.querySelector('.post_title_caption, .post_title, h2, h3');
          if (node) title = (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        }
        result.push({ id: match[1], title, href: link.href || raw });
      }
    };
    // 1) Enlaces de selección de anuncio (listan TODOS los posts)
    collect('a[href*="/users/posts/select/"]', /\/users\/posts\/select\/(\d+)/);
    // 2) Fallback: enlaces de bump directos
    if (result.length === 0) {
      collect('a[href*="/users/posts/bump/"]', /\/users\/posts\/bump\/(\d+)/);
    }
    return result;
  }).catch(() => []);

  if (ads.length === 0) {
    controller.log('⚠️ No se encontraron anuncios para rotar en Mis Anuncios.');
    return false;
  }

  const currentIds = ads.map((ad) => ad.id);
  const queue = (Array.isArray(controller.rotateQueue) ? controller.rotateQueue : [])
    .filter((id) => currentIds.includes(id));
  for (const id of currentIds) {
    if (!queue.includes(id)) queue.push(id);
  }
  controller.rotateQueue = queue;

  const targetId = queue.shift();
  queue.push(targetId);
  const position = currentIds.indexOf(targetId) + 1;
  const target = ads.find((ad) => ad.id === targetId) || { id: targetId, title: '' };

  controller.log(`🔄 Anuncio ${position}/${ads.length} (ID ${targetId}${target.title ? ` · ${target.title}` : ''}).`);

  const viaSelect = target.href && target.href.indexOf('/users/posts/select/') > -1;
  let clicked = false;

  if (viaSelect) {
    // Ir a la pagina del anuncio y pulsar "Bump to Top" (metodo fiable)
    try {
      await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (error) {
      controller.log(`No se pudo abrir el anuncio ${targetId}: ${error.message}`);
      return false;
    }
    if (await checkForBlock(page, controller)) return false;
    await sleep(2500);
    clicked = await page.evaluate(() => {
      const btn = document.getElementById('managePublishAd');
      if (!btn) return false;
      btn.click();
      return true;
    }).catch(() => false);
  } else {
    // Bump directo por enlace
    clicked = await page.evaluate((postId) => {
      const link = document.querySelector(`a[href*="/users/posts/bump/${postId}"]`);
      if (!link) return false;
      link.click();
      return true;
    }, targetId).catch(() => false);
  }

  if (!clicked) {
    controller.log(`❌ No se encontró el botón de bump del anuncio ${targetId}.`);
    return false;
  }

  const confirmed = await page.waitForFunction(
    () => window.location.href.includes('success_publish'),
    { timeout: 20000 }
  ).then(() => true).catch(() => false);

  if (!confirmed) {
    controller.log(`⚠️ El bump del anuncio ${targetId} no se confirmó.`);
    return false;
  }

  controller.log(`🚀 Bump confirmado (anuncio ${position}/${ads.length}, ID ${targetId}).`);
  controller.setCycleStage('completed', 'Bump confirmado.');
  controller.recordBump();
  saveState();
  if (await dismissOkModal(page)) await sleep(1200);
  await returnToPostsList(page, controller);
  return true;
}

async function clickTextControl(page, patterns, timeout = 10000) {
  let found = null;
  try {
    found = await page.waitForFunction((expectedPatterns) => {
      const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      return controls.some(control => {
        if (control.offsetParent === null || control.id === 'delete-post-id') return false;
        const text = `${control.innerText || ''} ${control.value || ''}`.trim();
        return expectedPatterns.some(pattern => new RegExp(pattern, 'i').test(text));
      });
    }, { timeout }, patterns);
  } catch (_) {
    return false;
  }

  if (!found) return false;
  await page.evaluate((expectedPatterns) => {
    const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    const target = controls.find(control => {
      if (control.offsetParent === null || control.id === 'delete-post-id') return false;
      const text = `${control.innerText || ''} ${control.value || ''}`.trim();
      return expectedPatterns.some(pattern => new RegExp(pattern, 'i').test(text));
    });
    if (target) target.click();
  }, patterns);
  return true;
}

async function fillFirst(page, selectors, value) {
  if (value === undefined || value === null || value === '') return false;
  for (const selector of selectors) {
    const field = await page.$(selector);
    if (field) {
      const tagName = await field.evaluate(element => element.tagName.toLowerCase());
      if (tagName === 'select') {
        const selected = await field.evaluate((element, wanted) => {
          const option = Array.from(element.options).find(item =>
            item.value === String(wanted) || item.textContent.trim().toLowerCase() === String(wanted).trim().toLowerCase()
          );
          if (!option) return false;
          element.value = option.value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, value);
        if (selected) return true;
        continue;
      }
      await field.click({ clickCount: 3 });
      await sleep(120 + Math.floor(Math.random() * 250));
      await field.type(String(value), { delay: 40 + Math.floor(Math.random() * 90) });
      return true;
    }
  }
  return false;
}

async function fillFieldByLabel(page, labelRegexSource, value) {
  if (value === undefined || value === null || value === '') return false;

  return page.evaluate((src, val) => {
    const re = new RegExp(src, 'i');
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const normalize = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const wanted = normalize(String(val));

    const setVal = (field) => {
      if (!field || !('value' in field)) return false;
      if (field.tagName === 'SELECT') {
        const opt = Array.from(field.options).find((o) => {
          const optionValue = normalize(o.value);
          const optionText = normalize(o.textContent);
          return optionValue === wanted || optionText === wanted || optionText.includes(wanted) || wanted.includes(optionText);
        }
        );
        if (!opt) return false;
        field.value = opt.value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        field.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      } else {
        const setter = Object.getOwnPropertyDescriptor(field.__proto__, 'value')?.set;
        if (setter) setter.call(field, String(val));
        else field.value = String(val);
      }
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    };

    const direct = Array.from(document.querySelectorAll('input, select, textarea')).find((field) => {
      const meta = normalize(`${field.name || ''} ${field.id || ''} ${field.getAttribute('autocomplete') || ''}`);
      return re.test(meta) || (src.toLowerCase().includes('city') && /city/.test(meta))
        || (src.toLowerCase().includes('location') && /location|area/.test(meta));
    });
    if (setVal(direct)) return true;

    const candidates = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'));
    for (const el of candidates) {
      const text = clean(el.textContent);
      if (!text || text.length > 30 || !re.test(text)) continue;

      if (el.tagName === 'LABEL' && el.htmlFor) {
        const f = document.getElementById(el.htmlFor);
        if (setVal(f)) return true;
      }

      let field = el.querySelector('input:not([type="hidden"]), select, textarea');
      if (setVal(field)) return true;

      let sib = el.nextElementSibling;
      while (sib) {
        field = sib.matches('input:not([type="hidden"]), select, textarea')
          ? sib
          : sib.querySelector('input:not([type="hidden"]), select, textarea');
        if (setVal(field)) return true;
        sib = sib.nextElementSibling;
      }

      const parent = el.parentElement;
      if (parent) {
        const fields = parent.querySelectorAll('input:not([type="hidden"]), select, textarea');
        if (fields.length === 1 && setVal(fields[0])) return true;
      }
    }
    return false;
  }, labelRegexSource, value);
}

async function fillPhone(page, value) {
  if (!value) return false;

  return page.evaluate((val) => {
    const raw = String(val).trim();
    const digits = raw.replace(/\D/g, '');
    const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : raw.replace(/[\s().-]+/g, '');

    const setVal = (f) => {
      if (!f || !('value' in f)) return false;
      const setter = Object.getOwnPropertyDescriptor(f.__proto__, 'value')?.set;
      if (setter) setter.call(f, normalized);
      else f.value = normalized;
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new Event('change', { bubbles: true }));
      f.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    };

    const direct = document.querySelector(
      'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
    );
    if (setVal(direct)) return true;

    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'));
    for (const el of labels) {
      const t = clean(el.textContent);
      if (!t || t.length > 30 || !/^\s*phone/i.test(t)) continue;
      const scope = el.parentElement || el;
      const num = Array.from(scope.querySelectorAll('input:not([type="hidden"])')).find((i) => i.type !== 'checkbox');
      if (setVal(num)) return true;
    }
    return false;
  }, value);
}

async function fillExactField(page, selector, value) {
  if (value === undefined || value === null || value === '') return false;
  return page.evaluate((fieldSelector, fieldValue) => {
    const field = document.querySelector(fieldSelector);
    if (!field || !('value' in field)) return false;
    const setter = Object.getOwnPropertyDescriptor(field.__proto__, 'value')?.set;
    if (setter) setter.call(field, String(fieldValue));
    else field.value = String(fieldValue);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    field.dispatchEvent(new Event('blur', { bubbles: true }));
    return String(field.value).trim() === String(fieldValue).trim();
  }, selector, value).catch(() => false);
}

async function selectCity(page, value, controller) {
  if (!value) return false;

  const selected = await page.waitForFunction((wantedValue) => {
    const normalize = (text) => String(text || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const wanted = normalize(wantedValue);
    const selects = Array.from(document.querySelectorAll('select')).filter((select) => {
      const meta = normalize(`${select.name || ''} ${select.id || ''} ${select.getAttribute('aria-label') || ''}`);
      const label = select.labels?.[0] ? normalize(select.labels[0].textContent) : '';
      return /city|town|location/.test(`${meta} ${label}`) || Array.from(select.options).some((option) => normalize(option.textContent).includes(wanted));
    });

    for (const select of selects) {
      const option = Array.from(select.options).find((item) => {
        const text = normalize(item.textContent);
        const optionValue = normalize(item.value);
        return text === wanted || optionValue === wanted || text.includes(wanted) || wanted.includes(text);
      });
      if (!option) continue;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('blur', { bubbles: true }));
      return select.value === option.value;
    }
    return false;
  }, { timeout: 2500 }, value).catch(() => false);

  if (selected) {
    controller.log(`📍 Ciudad seleccionada: ${value}.`);
    return true;
  }

  const [cityName, stateCode] = String(value).split(',').map((part) => part.trim());
  const stateNames = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming'
  };
  const stateName = stateNames[stateCode] || stateCode || '';

  const clickedCityField = await page.evaluate(() => {
    const knownField = document.querySelector('#cityName');
    if (knownField) {
      knownField.click();
      return true;
    }

    const normalize = (text) => String(text || '').toLowerCase();
    const field = Array.from(document.querySelectorAll('select, input, button, [role="combobox"]')).find((item) => {
      const meta = normalize(`${item.name || ''} ${item.id || ''} ${item.getAttribute('aria-label') || ''}`);
      const label = item.labels?.[0] ? normalize(item.labels[0].textContent) : '';
      return /city|town/.test(`${meta} ${label}`);
    });
    if (!field) return false;
    field.click();
    return true;
  });

  if (!clickedCityField) {
    controller.log(`❌ No se encontró el selector visual de ciudad para "${value}".`);
    return false;
  }
  controller.log(`📍 Abriendo selector de ubicación para ${value}.`);

  const clickLocationChoice = async (choice, label) => {
    controller.log(`📍 Seleccionando ${label}: ${choice}.`);
    const tryClick = () => page.evaluate((wanted) => {
      const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = normalize(wanted);
      const exactLabel = Array.from(document.querySelectorAll('label[for]')).find((el) =>
        normalize(el.textContent) === target && el.offsetParent !== null
      );
      if (exactLabel) {
        exactLabel.click();
        return true;
      }
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], li, option, div, span'))
        .filter((el) => el.offsetParent !== null || el.tagName === 'OPTION')
        .map((el) => ({ el, text: normalize(el.textContent) }))
        .filter((item) => item.text === target || item.text.startsWith(`${target} `) || item.text.startsWith(`${target},`))
        .sort((a, b) => a.text.length - b.text.length);
      const chosen = candidates[0];
      if (!chosen) return false;
      chosen.el.click();
      return true;
    }, choice).catch(() => false);

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (await tryClick()) return true;
      await sleep(1200);
    }
    controller.log(`❌ No se encontró la opción ${label}: ${choice} tras varios intentos.`);
    return false;
  };

  const countryClicked = await page.evaluate(() => {
    const countryLabel = document.querySelector('label[for="ac-United States"]');
    if (!countryLabel || countryLabel.offsetParent === null) return false;
    countryLabel.click();
    return true;
  }).catch(() => false) || await clickLocationChoice('United States', 'país');
  if (!countryClicked) {
    const countrySelected = await page.evaluate(() => {
      const countryLabel = document.querySelector('label[for="ac-United States"]');
      if (countryLabel && countryLabel.offsetParent !== null) {
        countryLabel.click();
        return true;
      }
      const select = document.querySelector('#countrySelect');
      if (!select) return false;
      const option = Array.from(select.options).find((item) => /united states/i.test(item.textContent || ''));
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if (!countrySelected) {
      controller.setCycleStage('error', 'No se encontró United States.');
      return false;
    }
    controller.log('📍 United States seleccionado mediante #countrySelect.');
  }
  await sleep(1000);
  if (stateName && !(await clickLocationChoice(stateName, 'estado'))) return false;
  if (!(await clickLocationChoice(cityName, 'ciudad'))) return false;

  const verified = await page.waitForFunction((wantedValue) => {
    const normalize = (text) => String(text || '').trim().toLowerCase();
    const wanted = normalize(wantedValue);
    const knownField = document.querySelector('#cityName');
    if (knownField) {
      const knownValue = normalize(knownField.value);
      if (knownValue === wanted || knownValue.includes(wanted)) return true;
    }
    return Array.from(document.querySelectorAll('select, input')).some((field) => {
      const value = normalize(field.value);
      const option = field.tagName === 'SELECT' ? field.selectedOptions[0] : null;
      const optionText = normalize(option?.textContent);
      return value === wanted || value.includes(wanted) || optionText === wanted || optionText.includes(wanted);
    });
  }, { timeout: 5000 }, cityName).catch(() => false);

  if (!verified) {
    controller.log(`❌ No se encontró la ciudad "${value}" entre las opciones del formulario.`);
    return false;
  }
  controller.log(`📍 Ciudad seleccionada: ${value}.`);
  return true;
}

async function clickNextStep(page, controller) {
  const directClicked = await page.evaluate(() => {
    const button = document.querySelector('#next_button_from_first_form_page');
    if (!button || button.offsetParent === null) return false;
    button.click();
    return true;
  }).catch(() => false);
  const clicked = directClicked || await clickTextControl(page, ['^next$', 'continue', 'siguiente'], 8000);
  if (!clicked) {
    controller.log('❌ No se encontró el botón Next del formulario.');
    return false;
  }
  await sleep(1500);
  controller.setCycleStage('photos', 'Paso de fotos abierto.');
  controller.log('➡️ Paso de fotos abierto.');
  return true;
}

async function detectCaptchaFields(page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('input, textarea'));
      const field = fields.find((item) => /captcha|code from|verification/i.test(`${item.name || ''} ${item.id || ''} ${item.placeholder || ''}`));
      const recaptcha = document.querySelector('textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response');
      return { imageField: Boolean(field), recaptcha: Boolean(recaptcha) };
    }).catch(() => ({ imageField: false, recaptcha: false }));
    if (found.imageField || found.recaptcha) return found;
  }
  return { imageField: false, recaptcha: false };
}

async function isCaptchaSolved(page) {
  const selector = CAPTCHA_INPUT_SELECTORS.join(', ');
  for (const frame of page.frames()) {
    const solved = await frame.evaluate((sel) => {
      const input = document.getElementById('captcha_code') || document.querySelector(sel);
      if (input && String(input.value || '').trim()) return true;
      const recaptcha = document.querySelector('textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response');
      return Boolean(recaptcha && recaptcha.value.trim());
    }, selector).catch(() => false);
    if (solved) return true;
  }
  return false;
}

async function waitForCaptchaSolved(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCaptchaSolved(page)) return true;
    await sleep(1000);
  }
  return false;
}

async function waitForManualCaptcha(page, controller) {
  const captcha = await detectCaptchaFields(page);

  if (!captcha.imageField && !captcha.recaptcha) return true;

  controller.setCycleStage('captcha', 'CAPTCHA detectado.');
  controller.log(`🧩 CAPTCHA detectado (reCAPTCHA: ${captcha.recaptcha ? 'sí' : 'no'}, campo de código: ${captcha.imageField ? 'sí' : 'no'}). Intentando resolver con 2Captcha...`);

  try {
    fs.writeFileSync(path.join(LOGS_DIR, `dump-captcha-${controller.id}.html`), await page.content(), 'utf8');
  } catch (_) {
    // sin dump disponible
  }

  await handleCaptchaIfPresent(page, controller);

  const solvedAuto = await waitForCaptchaSolved(page, 15000);

  if (solvedAuto) {
    controller.setCycleStage('captcha', 'CAPTCHA resuelto automáticamente.');
    controller.log('✅ CAPTCHA resuelto e introducido automáticamente.');
    return true;
  }

  controller.setCycleStage('captcha', 'Esperando CAPTCHA manual.');
  controller.log('🧩 CAPTCHA no resuelto automáticamente. Introduce el código manualmente en Chrome; el proceso esperará hasta 5 minutos.');
  const solved = await waitForCaptchaSolved(page, 300000);

  if (!solved) {
    controller.setCycleStage('error', 'Tiempo agotado esperando CAPTCHA.');
    controller.log('❌ Tiempo agotado esperando el CAPTCHA manual.');
  }
  return solved;
}

// Popup de ciudad de pago: hay que confirmarlo para que se envíe el formulario
async function confirmTokenPopup(page) {
  return page.evaluate(() => {
    const popup = document.getElementById('confirmModal_enoughTokens');
    if (!popup) return false;
    const visible = popup.offsetParent !== null && getComputedStyle(popup).display !== 'none';
    if (!visible) return false;
    const confirm = document.getElementById('createBumpPostUrl')
      || Array.from(popup.querySelectorAll('.flex-btn div, button, a'))
        .find((el) => el.offsetParent !== null && /ok|accept|continue|confirm|publish|post/i.test(`${el.innerText || ''} ${el.id || ''}`));
    if (confirm) {
      confirm.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

// Modal "Success!" con botón OK (success_publish / imágenes revisadas): hay que cerrarlo para seguir
async function dismissOkModal(page) {
  return page.evaluate(() => {
    const byId = document.getElementById('success-ok');
    if (byId && byId.offsetParent !== null) { byId.click(); return true; }
    const byImg = Array.from(document.querySelectorAll('img')).find((el) => el.offsetParent !== null && /buttonok/i.test(el.getAttribute('src') || ''));
    if (byImg) { byImg.click(); return true; }
    const byText = Array.from(document.querySelectorAll('button, a, input[type="button"], div'))
      .find((el) => el.offsetParent !== null && /^ok$/i.test((el.innerText || el.value || '').trim()));
    if (byText) { byText.click(); return true; }
    return false;
  }).catch(() => false);
}

// Página de imágenes pendientes (/users/pendingImages/...): hay que pulsar el botón OK
async function clickPendingImagesOk(page) {
  return page.evaluate(() => {
    const ok = document.getElementById('success-ok')
      || Array.from(document.querySelectorAll('img, button, a, div'))
        .find((el) => el.offsetParent !== null && /buttonok|success-ok/i.test(`${el.id || ''} ${el.getAttribute('src') || ''}`));
    if (ok) {
      ok.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

// Detecta si el sitio rechazó el captcha (aunque el modal esté oculto)
async function detectCaptchaRejected(page) {
  return page.evaluate(() => {
    if (document.querySelector('[id="captchaCode.errors"], #captchaCode.errors')) return true;
    const modal = document.getElementById('captcha-modal');
    if (modal) {
      const visible = modal.classList.contains('show') || (modal.offsetParent !== null && getComputedStyle(modal).display !== 'none');
      if (visible && /does not match|incorrect|invalid|captcha code/i.test(modal.innerText || '')) return true;
    }
    const body = document.body ? document.body.innerText : '';
    return /does not match|incorrect captcha|invalid captcha/i.test(body);
  }).catch(() => false);
}

// Devuelve la siguiente variante de texto/título (rota) o el valor normal si no hay variantes.
function pickVariant(controller, field) {
  const details = controller.cfg.adDetails || {};
  const variants = Array.isArray(details[`${field}Variants`])
    ? details[`${field}Variants`].map((v) => String(v || '')).filter((v) => v.trim())
    : [];
  if (variants.length === 0) return String(details[field] || '');
  if (!controller.variantIndex) controller.variantIndex = {};
  const idx = Math.abs(Number(controller.variantIndex[field]) || 0) % variants.length;
  controller.variantIndex[field] = (idx + 1) % variants.length;
  saveState();
  return variants[idx];
}

async function deleteAndRepost(page, controller, options = {}) {
  const urls = siteUrls(controller);
  const details = controller.cfg.adDetails || {};
  const configErrors = validateCycleConfig(controller.cfg);
  if (configErrors.length > 0) {
    controller.setCycleStage('error', `Configuración inválida: ${configErrors.join(', ')}.`);
    controller.log(`Delete and Repost omitido: ${configErrors.join(', ')}.`);
    return false;
  }

  try {
    if (!options.resume) {
      controller.cycleDeleteCompleted = false;
    }

    if (!controller.cycleDeleteCompleted) {
      controller.setCycleStage('removing', 'Abriendo Manage Posts.');
      controller.log('🗑️ Iniciando ciclo de borrado del anuncio actual...');
      await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });

      if (await ensureSession(page, controller)) {
        await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      }
      if (await checkForBlock(page, controller)) return false;

      const deleteClicked = await page.evaluate(() => {
      const knownButton = document.querySelector('#delete-post-id');
      if (knownButton && knownButton.offsetParent !== null) {
        knownButton.click();
        return true;
      }
      const fallback = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
        .find((el) => el.offsetParent !== null && /delete|remove|borrar|eliminar/i.test(`${el.innerText || ''} ${el.value || ''}`));
      if (!fallback) return false;
      fallback.click();
      return true;
      });
      if (!deleteClicked) {
        controller.log('ℹ️ El post ya no aparece en Manage Posts; continúo directamente con Create Post.');
      } else {
        await sleep(3000);

        await page.waitForFunction(() => {
          const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
          return controls.some(control => /confirm|yes|sí|si|delete|borrar/i.test(`${control.innerText || ''} ${control.value || ''}`));
        }, { timeout: 5000 }).then(() => clickTextControl(page, ['confirm', '^yes$', '^sí$', '^si$', 'delete', 'remove', 'borrar'], 3000)).catch(() => {});
        await sleep(1000);
      }
      controller.cycleDeleteCompleted = true;
      saveState();
    }

    controller.log('📢 Publicando nuevo anuncio idéntico...');
    controller.setCycleStage('filling', 'Llenando datos del anuncio.');
    await page.goto(urls.create, { waitUntil: 'networkidle2', timeout: 60000 });

    if (await checkForBlock(page, controller)) return false;

    const headlineToUse = pickVariant(controller, 'headline');
    const textToUse = pickVariant(controller, 'text');
    if (headlineToUse && headlineToUse !== details.headline) controller.log(`🔤 Usando variante de título.`);
    if (textToUse && textToUse !== details.text) controller.log(`🔤 Usando variante de texto.`);
    await fillExactField(page, '#name', details.name) || await fillFieldByLabel(page, '^\\s*name', details.name);
    await fillFieldByLabel(page, '^\\s*headline', headlineToUse);
    await fillExactField(page, '#age', details.age) || await fillFieldByLabel(page, '^\\s*age', details.age);
    await fillFieldByLabel(page, '^\\s*body', textToUse);
    controller.setCycleStage('city', `Seleccionando ciudad: ${details.city}.`);
    if (!(await selectCity(page, details.city, controller))) return false;
    const locationFilled = await fillExactField(page, '#location', details.location)
      || await fillFieldByLabel(page, '^\\s*location', details.location);
    if (details.location && !locationFilled) {
      controller.setCycleStage('error', `No se pudo escribir la ubicación: ${details.location}.`);
      controller.log(`❌ No se pudo llenar Location/Area con "${details.location}".`);
      return false;
    }
    if (locationFilled) controller.log(`📍 Location/Area escrito: ${details.location}.`);
    await fillPhone(page, details.phone);

    if (!(await clickNextStep(page, controller))) return false;

    if (details.photosPath) {
      controller.setCycleStage('photos', 'Cargando fotos.');
      const photosDir = path.resolve(__dirname, details.photosPath);
      const photoInputs = await page.$$('input[type="file"]');
      let photoInput = null;
      let acceptsMultiple = false;
      for (const input of photoInputs) {
        const info = await input.evaluate((el) => ({ multiple: Boolean(el.multiple) })).catch(() => ({ multiple: false }));
        if (info.multiple) {
          photoInput = input;
          acceptsMultiple = true;
          break;
        }
        if (!photoInput) photoInput = input;
      }
      if (!photoInput) {
        controller.setCycleStage('error', 'No se encontró el campo de fotos.');
        controller.log('❌ No se encontró el campo de fotos en el formulario.');
        return false;
      }
      if (fs.existsSync(photosDir)) {
        const photos = fs.readdirSync(photosDir)
          .filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name))
          .map(name => path.join(photosDir, name));
        if (photos.length > 0) {
          if (acceptsMultiple) {
            try {
              await photoInput.uploadFile(...photos);
            } catch (error) {
              controller.log(`⚠️ Subida múltiple falló (${error.message}); subiendo una por una...`);
              for (const photo of photos) {
                await photoInput.uploadFile(photo);
                await sleep(800);
              }
            }
          } else {
            for (const photo of photos) {
              await photoInput.uploadFile(photo);
              await sleep(800);
            }
          }
          controller.log(`🖼️ ${photos.length} foto(s) cargadas en el formulario.`);
        } else {
          controller.setCycleStage('error', 'La carpeta de fotos está vacía.');
          controller.log('❌ No hay fotos en la carpeta configurada.');
          return false;
        }
      }
    }

    if (!(await waitForManualCaptcha(page, controller))) return false;

    controller.setCycleStage('publishing', 'Publicando anuncio.');
    let confirmed = false;
    for (let attempt = 1; attempt <= 3 && !confirmed; attempt++) {
      let published = await clickTextControl(page, ['publish', 'post\\s+ad', 'publicar', 'crear anuncio'], 10000);
      if (!published) {
        published = await page.evaluate(() => {
          // Botón real de MegaPersonals: <div id="input_send" class="myButton previewbutton"> (sin texto)
          const direct = document.getElementById('input_send')
            || document.querySelector('.myButton.previewbutton');
          if (direct && direct.offsetParent !== null) {
            direct.click();
            return true;
          }
          const form = document.querySelector('form');
          const submit = form && form.querySelector('button[type="submit"], input[type="submit"]');
          if (submit && submit.offsetParent !== null && !submit.disabled) {
            submit.click();
            return true;
          }
          const any = Array.from(document.querySelectorAll('button, input[type="submit"], a'))
            .find((el) => el.offsetParent !== null && !el.disabled && /publish|post\s*ad|submit|publicar|send/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''}`));
          if (any) {
            any.click();
            return true;
          }
          return false;
        }).catch(() => false);
      }
      if (!published) {
        controller.log('No se encontró el botón final de publicación.');
        return false;
      }

      // Espera la confirmación (proxy lento). Maneja el popup de tokens y la página de imágenes pendientes.
      const deadline = Date.now() + 60000;
      let tokenLogged = false;
      let okLogged = false;
      let sawPendingImages = false;
      let captchaRejected = false;
      while (Date.now() < deadline && !confirmed) {
        confirmed = await page.evaluate(() => window.location.href.includes('success_publish')).catch(() => false);
        if (confirmed) break;

        if (page.url().includes('pendingImages')) {
          sawPendingImages = true;
          if (await clickPendingImagesOk(page)) {
            if (!okLogged) {
              controller.log('🖼️ Página de imágenes pendientes; pulsando OK...');
              okLogged = true;
            }
          }
        }

        if (await confirmTokenPopup(page)) {
          if (!tokenLogged) {
            controller.log('🪙 Popup de tokens detectado; confirmando publicación...');
            tokenLogged = true;
          }
        }

        captchaRejected = await detectCaptchaRejected(page);
        if (captchaRejected) break;

        // Si ya salimos de la página de imágenes pendientes tras pulsar OK, se considera publicado.
        if (sawPendingImages && okLogged && !page.url().includes('pendingImages')) {
          confirmed = true;
          break;
        }

        await sleep(1500);
      }
      if (confirmed) break;

      if (captchaRejected && attempt < 3) {
        controller.log(`⚠️ CAPTCHA rechazado (intento ${attempt}). Recargando y reintentando...`);
        await reloadImageCaptcha(page);
        await sleep(1500);
        if (!(await waitForManualCaptcha(page, controller))) return false;
        continue;
      }
      break;
    }
    if (!confirmed) {
      if (await checkForBlock(page, controller)) return false;
      controller.setCycleStage('error', 'No se confirmó success_publish.');
      controller.log('❌ El formulario se envió, pero no apareció la confirmación success_publish.');
      return false;
    }

    controller.log('✅ ¡Anuncio republicado de forma idéntica con éxito!');
    controller.setCycleStage('completed', 'Publicación confirmada.');
    controller.cycleDeleteCompleted = false;
    saveState();
    controller.recordBump();

    // Cerrar el modal "Success!" con OK para poder seguir
    if (await dismissOkModal(page)) {
      controller.log('✅ Modal de confirmación cerrado; continúo con el ciclo.');
      await sleep(1200);
    }

    // Volver a la lista de anuncios (MY POSTS)
    const wentBack = await clickTextControl(page, ['my\\s+posts', 'mis\\s+anuncios'], 6000);
    if (wentBack) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } else {
      await page.goto(urls.manage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    await sleep(1000);

    return true;
  } catch (error) {
    controller.log(`❌ Error en el ciclo de republicación: ${error.message}`);
    return false;
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

function detectChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // candidato inválido, seguir
    }
  }
  return null;
}

function parseProxy(value) {
  if (!value) return null;

  const normType = (t) => (String(t || '').toLowerCase() === 'socks5' ? 'socks5' : 'http');

  if (typeof value === 'object') {
    if (!value.host) return null;
    return {
      host: String(value.host).trim(),
      port: Number(value.port) || 0,
      username: String(value.username || ''),
      password: String(value.password || ''),
      type: normType(value.type)
    };
  }

  const raw = String(value).trim();
  if (!raw) return null;

  const parts = raw.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;

  return {
    host: parts[0].trim(),
    port: Number(parts[1]) || 0,
    username: (parts[2] || '').trim(),
    password: (parts[3] || '').trim(),
    type: normType(parts[4])
  };
}

function validateCycleConfig(profile) {
  const details = profile.adDetails || {};
  const errors = [];
  const phoneDigits = String(details.phone || '').replace(/\D/g, '');

  if (!String(details.city || '').trim()) errors.push('falta la ciudad');
  const hasText = String(details.text || '').trim()
    || (Array.isArray(details.textVariants) && details.textVariants.some((v) => String(v || '').trim()));
  if (!hasText) errors.push('falta el texto del anuncio');
  if (details.phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) errors.push('teléfono inválido');
  if (details.age && (!Number.isInteger(Number(details.age)) || Number(details.age) < 18 || Number(details.age) > 100)) errors.push('edad inválida');

  if (details.photosPath) {
    const photosRoot = path.resolve(__dirname, 'profiles');
    const photosDir = path.resolve(__dirname, details.photosPath);
    const relative = path.relative(photosRoot, photosDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) errors.push('fotos fuera de profiles');
    else if (!fs.existsSync(photosDir) || !fs.statSync(photosDir).isDirectory()) errors.push('carpeta de fotos inexistente');
  }

  const min = Number(profile.bumpMinMinutes || profile.intervalMinutes || 16);
  const max = Number(profile.bumpMaxMinutes || min);
  if (!Number.isFinite(min) || min < 1 || !Number.isFinite(max) || max < min) errors.push('intervalo de bump inválido');
  return errors;
}

async function scrapeActiveAdData(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    // --- Vista "Manage Posts": anuncio con post_title_caption / post_preview_* ---
    const titleEl = document.querySelector('.post_title_caption');
    const contentEl = document.querySelector('.post_preview_content');
    if (titleEl || contentEl) {
      const spans = Array.from(document.querySelectorAll('.post_preview_info span'));
      const rows = Array.from(document.querySelectorAll('.post_preview_info > div, .post_preview_info li, .post_preview_info p'));
      const readRow = (label) => {
        const row = rows.find((item) => clean(item.querySelector('span')?.textContent).toLowerCase().startsWith(label.toLowerCase()));
        if (!row) return '';
        const values = Array.from(row.querySelectorAll('span')).slice(1).map((item) => clean(item.textContent)).filter(Boolean);
        return values.join(' ').trim();
      };
      const readInfo = (label) => {
        const idx = spans.findIndex((s) => clean(s.textContent).toLowerCase().startsWith(label.toLowerCase()));
        if (idx === -1) return '';
        const parts = [];
        for (let i = idx + 1; i < spans.length; i++) {
          const t = clean(spans[i].textContent);
          if (!t) continue;
          if (/:$/.test(t)) break;
          parts.push(t);
        }
        return parts.join(' ').trim();
      };

      return {
        name: '',
        headline: clean(titleEl ? titleEl.textContent : ''),
        age: readRow('Age') || readInfo('Age'),
        text: contentEl ? contentEl.textContent.trim() : '',
        city: readRow('City') || readInfo('City'),
        location: readRow('Location') || readInfo('Location'),
        phone: readRow('Phone') || readInfo('Phone')
      };
    }

    const readByLabel = (labelRegexSource) => {
      const re = new RegExp(labelRegexSource, 'i');
      const candidates = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'));
      for (const el of candidates) {
        const text = clean(el.textContent);
        if (!text || text.length > 30) continue;
        if (!re.test(text)) continue;

        if (el.tagName === 'LABEL' && el.htmlFor) {
          const f = document.getElementById(el.htmlFor);
          if (f && 'value' in f) return f.value;
        }

        let field = el.querySelector('input:not([type="hidden"]), select, textarea');
        if (field && 'value' in field) return field.value;

        let sib = el.nextElementSibling;
        while (sib) {
          field = sib.matches('input:not([type="hidden"]), select, textarea')
            ? sib
            : sib.querySelector('input:not([type="hidden"]), select, textarea');
          if (field && 'value' in field) return field.value;
          sib = sib.nextElementSibling;
        }

        const parent = el.parentElement;
        if (parent) {
          field = parent.querySelector('input:not([type="hidden"]), select, textarea');
          if (field && 'value' in field) return field.value;
        }
      }
      return '';
    };

    const readByName = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && 'value' in el && el.value) return el.value;
      }
      return '';
    };

    return {
      name: readByLabel('^\\s*name') || readByLabel('alias'),
      headline: readByLabel('^\\s*headline') || readByLabel('^\\s*title'),
      age: readByLabel('^\\s*age') || readByName(['input[name="age"]', 'select[name="age"]', 'input[name*="age" i]:not([type="hidden"])']),
      text: readByLabel('^\\s*body') || readByName(['textarea[name="body"]', 'textarea[name*="text" i]', 'textarea[name*="description" i]', 'textarea']),
      city: readByLabel('^\\s*city') || readByName(['input[name="city"]', 'select[name="city"]', 'input[name*="city" i]:not([type="hidden"])']),
      location: readByLabel('^\\s*location') || readByLabel('area'),
      phone: (() => {
        const tel = document.querySelector('input[type="tel"]');
        if (tel && /\d{5,}/.test(tel.value || '')) return tel.value;
        const re = /^\s*phone/i;
        const candidates = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'));
        for (const el of candidates) {
          const text = clean(el.textContent);
          if (!text || text.length > 30 || !re.test(text)) continue;
          const scope = el.parentElement || el;
          const inputs = Array.from(scope.querySelectorAll('input:not([type="hidden"])'));
          const num = inputs.find((i) => /\d{5,}/.test(i.value || ''));
          if (num) return num.value;
        }
        return '';
      })()
    };
  });
}

async function scrapeActiveAdFromText(page) {
  return page.evaluate(() => {
    const text = (document.body ? document.body.innerText : '') || '';
    const grab = (re) => {
      const m = text.match(re);
      return m ? m[1].trim() : '';
    };

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    return {
      phone: grab(/phone\s*:\s*([+\d][\d\s().-]{5,})/i),
      age: grab(/age\s*:\s*(\d{1,3})/i),
      city: grab(/city\s*:\s*([^\n\r]+)/i),
      location: grab(/location\s*:\s*([^\n\r]+)/i),
      headline: lines.length ? lines[0] : ''
    };
  });
}

async function scrapeActiveAdPhotos(page) {
  return page.evaluate(() => {
    const urls = new Set();

    const add = (img) => {
      const src = img.currentSrc || img.src;
      if (!src || !/^https?:/i.test(src)) return;
      if (img.naturalWidth < 200 || img.naturalHeight < 200) return;
      const meta = `${img.className || ''} ${img.id || ''} ${img.alt || ''} ${src}`.toLowerCase();
      if (/(logo|icon|sprite|banner|avatar|emoji|flag|placeholder|loader|spinner)/.test(meta)) return;
      urls.add(src);
    };

    document.querySelectorAll('.post_preview_media img, .media-wrapper img').forEach(add);

    if (urls.size === 0) {
      const galleries = document.querySelectorAll(
        '[class*="photo" i], [class*="gallery" i], [class*="pic" i], [class*="upload" i], [class*="image" i], [class*="media" i], ' +
        '[id*="photo" i], [id*="gallery" i], [id*="upload" i], [id*="image" i]'
      );
      galleries.forEach((g) => g.querySelectorAll('img').forEach(add));
    }

    if (urls.size === 0) document.querySelectorAll('img').forEach(add);

    return [...urls];
  });
}

function buildProxyDispatcher(proxy) {
  if (!proxy || !proxy.host) return null;
  // undici no soporta SOCKS5: en ese caso no usamos dispatcher (el navegador si lo usa).
  if (proxy.type === 'socks5') return null;

  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;

  return new ProxyAgent(proxyUrl);
}

// Chrome no soporta SOCKS5 con usuario/clave. Hacemos un puente local:
// Chrome -> HTTP proxy local (sin auth) -> SOCKS5 con auth -> destino
function socks5Connect(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let stage = 'greet';
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      if (err) { try { socket.destroy(); } catch (_) {} return reject(err); }
      socket.setTimeout(0);
      resolve(socket);
    };
    socket.setTimeout(20000, () => finish(new Error('timeout conectando al proxy SOCKS5')));
    socket.on('error', (e) => finish(e));
    socket.on('close', () => { if (!settled) finish(new Error('el proxy SOCKS5 cerró la conexión')); });
    socket.on('connect', () => {
      socket.write(proxy.username ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const method = buf[1]; buf = buf.slice(2);
        if (method === 2) {
          const u = Buffer.from(String(proxy.username || ''));
          const p = Buffer.from(String(proxy.password || ''));
          socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
          return;
        }
        if (method === 0) { stage = 'connect'; } else return finish(new Error('el proxy SOCKS5 no aceptó el método de auth'));
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const status = buf[1]; buf = buf.slice(2);
        if (status !== 0) return finish(new Error('credenciales SOCKS5 rechazadas'));
        stage = 'connect';
      }
      if (stage === 'connect') {
        const hostBuf = Buffer.from(targetHost);
        socket.write(Buffer.concat([
          Buffer.from([5, 1, 0, 3, hostBuf.length]), hostBuf,
          Buffer.from([(targetPort >> 8) & 255, targetPort & 255])
        ]));
        stage = 'reply';
        buf = Buffer.alloc(0);
        return;
      }
      if (stage === 'reply') {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return finish(new Error(`el proxy SOCKS5 no pudo conectar al destino (${buf[1]})`));
        const atyp = buf[3];
        let len = 4;
        if (atyp === 1) len += 4;
        else if (atyp === 3) len += 1 + buf[4];
        else if (atyp === 4) len += 16;
        len += 2;
        if (buf.length < len) return;
        finish(null);
      }
    };
    socket.on('data', onData);
  });
}

function startSocksBridge(proxy) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Puente SOCKS5: solo HTTPS (CONNECT).');
    });
    server.on('connect', async (req, clientSocket, head) => {
      try {
        const parts = String(req.url).split(':');
        const host = parts[0];
        const port = Number(parts[1]) || 443;
        const upstream = await socks5Connect(proxy, host, port);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        const closeBoth = () => { try { upstream.destroy(); } catch (_) {} try { clientSocket.destroy(); } catch (_) {} };
        upstream.on('error', closeBoth);
        upstream.on('close', closeBoth);
        clientSocket.on('error', closeBoth);
        clientSocket.on('close', closeBoth);
      } catch (error) {
        try { clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (_) {}
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const proxyGeoCache = new Map();
async function resolveProxyGeo(browser, proxy) {
  if (!proxy || !proxy.host) return null;
  const key = `${proxy.type || 'http'}://${proxy.host}:${proxy.port}`;
  const cached = proxyGeoCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;

  let tmp;
  try {
    tmp = await browser.newPage();
    if (proxy.type !== 'socks5' && proxy.username) {
      await tmp.authenticate({ username: proxy.username, password: proxy.password || '' }).catch(() => {});
    }
    await tmp.goto('http://ip-api.com/json/?fields=status,country,city,timezone,lat,lon', {
      waitUntil: 'domcontentloaded',
      timeout: 8000
    });
    const txt = await tmp.evaluate(() => (document.body ? document.body.innerText : ''));
    const data = JSON.parse(txt);
    if (data && data.status === 'success') {
      proxyGeoCache.set(key, { at: Date.now(), data });
      return data;
    }
  } catch (_) {
  } finally {
    if (tmp) await tmp.close().catch(() => {});
  }
  proxyGeoCache.set(key, { at: Date.now(), data: null });
  return null;
}

async function downloadAndSanitizePhoto(imageUrl, outputFolder, profileId, dispatcher) {
  try {
    const response = await undiciFetch(imageUrl, dispatcher ? { dispatcher } : undefined);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} al descargar la imagen.`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const targetDir = outputFolder || path.join(__dirname, 'profiles', profileId, 'photos');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const filename = `sanitized_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
    const outputPath = path.join(targetDir, filename);

    await sharp(buffer)
      .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
      .modulate({ brightness: 1.01, saturation: 1.02 })
      .jpeg({ quality: 95, mozjpeg: true })
      .toFile(outputPath);

    console.log(`🛡️ Foto procesada y blindada con éxito: ${outputPath}`);
    return outputPath;
  } catch (error) {
    console.error(`❌ Error al limpiar la foto: ${error.message}`);
    return null;
  }
}

class ProfileController {
  constructor(cfg) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.browser = null;
    this.page = null;
    this.started = false;
    this.paused = false;
    this._nextBumpAt = 0;
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    this._openPromise = null;
    this._startPromise = null;
    this._operationPromise = null;
    this._nextRepostAt = 0;
    this.autoRepostActive = Boolean(cfg.autoRepostActive);
    this.repostInterval = Number(cfg.repostInterval) || 6;
    this.repostIntervalMin = Number(cfg.repostIntervalMin) || this.repostInterval * 60;
    this.state = 'stopped';
    this.cycleStage = 'idle';
    this.cycleDetail = '';
    this.cycleUpdatedAt = 0;
    this.cycleDeleteCompleted = false;
    this.rotateQueue = [];
    this.variantIndex = {};
    this._stopping = false;
    this._recovering = false;
    this._socksBridge = null;
    this.stats = { totalBumps: 0, bumpsToday: 0, lastBumpAt: 0, date: todayKey() };
    this.health = {
      lastOperation: '',
      lastOperationAt: 0,
      lastOkAt: 0,
      lastError: '',
      lastErrorAt: 0,
      errors: 0,
      consecutiveFailures: 0,
      warnings: []
    };
    this.settings = {
      rotateAds: Boolean(cfg.settings?.rotateAds),
      randomizedDelay: cfg.settings?.randomizedDelay !== false,
      publishOnStart: Boolean(cfg.settings?.publishOnStart)
    };
    this.limits = {
      dailyLimit: Number(cfg.limits?.dailyLimit) || 0,
      conservativeMode: Boolean(cfg.limits?.conservativeMode)
    };
  }

  noteOperation(op) {
    this.health.lastOperation = op;
    this.health.lastOperationAt = Date.now();
    io.emit('health', this.healthSnapshot());
  }

  noteOk() {
    this.health.lastOkAt = Date.now();
    this.health.lastError = '';
  }

  noteError(message) {
    this.health.errors += 1;
    this.health.lastError = String(message || '').slice(0, 200);
    this.health.lastErrorAt = Date.now();
    io.emit('health', this.healthSnapshot());
  }

  warn(message) {
    this.log(`⚠️ ${message}`);
    this.health.warnings.push({ at: Date.now(), message: String(message).slice(0, 200) });
    if (this.health.warnings.length > 50) this.health.warnings.shift();
    io.emit('health', this.healthSnapshot());
  }

  // Auto-pausa si falla varias veces seguidas
  recordCycleResult(ok) {
    if (ok) {
      this.health.consecutiveFailures = 0;
      return;
    }
    this.health.consecutiveFailures = (this.health.consecutiveFailures || 0) + 1;
    io.emit('health', this.healthSnapshot());
    if (this.health.consecutiveFailures >= 3 && this.started && !this.paused) {
      this.warn('3 fallos seguidos: pauso el perfil por seguridad.');
      this.pause();
      notify(`⚠️ Perfil "${this.id}" pausado tras 3 fallos seguidos.`);
    }
  }

  healthSnapshot() {
    return {
      id: this.id,
      state: this.state,
      started: this.started,
      paused: this.paused,
      lastOperation: this.health.lastOperation,
      lastOperationAt: this.health.lastOperationAt,
      lastOkAt: this.health.lastOkAt,
      lastError: this.health.lastError,
      lastErrorAt: this.health.lastErrorAt,
      errors: this.health.errors,
      consecutiveFailures: this.health.consecutiveFailures || 0,
      warnings: this.health.warnings.slice(-10),
      bumpsToday: this.stats.bumpsToday,
      dailyLimit: this.limits.dailyLimit,
      proxy: this.cfg.proxy ? `${this.cfg.proxy.host}:${this.cfg.proxy.port}` : ''
    };
  }

  log(text) {
    const level = /❌|error|crítico|falló|inválid/i.test(text)
      ? 'error'
      : /⚠|aviso|esperando|omitido/i.test(text)
        ? 'warning'
        : /✅|confirmado|éxito|OK/i.test(text)
          ? 'success'
          : 'info';
    console.log(`[${this.id}]`, text);
    logToFile(this.id, text);
    io.emit('log', { id: this.id, text, level, at: Date.now() });
  }

emitActive() {
    let active = 0;
    for (const c of controllers.values()) {
      if (c.browser) active++;
    }
    io.emit('active-count', { active });
  }

  emitState(state) {
    this.state = state;
    io.emit('profile-state', { id: this.id, state });
  }

  setCycleStage(stage, detail = '') {
    this.cycleStage = stage;
    this.cycleDetail = detail;
    this.cycleUpdatedAt = Date.now();
    io.emit('cycle-stage', {
      id: this.id,
      stage,
      detail,
      at: this.cycleUpdatedAt
    });
    saveState();
  }

  emitStats() {
    io.emit('stats', { id: this.id, stats: this.stats });
  }

  recordBump() {
    const today = todayKey();
    if (this.stats.date !== today) {
      this.stats.date = today;
      this.stats.bumpsToday = 0;
    }
    this.stats.bumpsToday += 1;
    this.stats.totalBumps += 1;
    this.stats.lastBumpAt = Date.now();
    const times = recentBumpTimes.get(this.id) || [];
    times.push(Date.now());
    recentBumpTimes.set(this.id, times.slice(-30));
    saveState();
    this.emitStats();
  }

  closeSocksBridge() {
    if (this._socksBridge) {
      try { this._socksBridge.close(); } catch (_) {}
      this._socksBridge = null;
    }
  }

  async launchProfile() {
    const profileDir = path.join(__dirname, 'profiles', `perfil_${this.id}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.cfg.port}`,
      `--user-data-dir=${profileDir}`,
      '--disable-blink-features=AutomationControlled',
      '--window-size=390,844',
      '--lang=en-US',
      '--hide-crash-restore-bubble',
      '--no-first-run',
      '--no-default-browser-check',
      // Anti-fuga de IP real por WebRTC
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check'
    ];

    const proxy = this.cfg.proxy;
    if (proxy && proxy.host) {
      if (proxy.type === 'socks5' && proxy.username) {
        // Chrome no soporta SOCKS5 con auth: levantamos un puente local.
        this.closeSocksBridge();
        try {
          this._socksBridge = await startSocksBridge(proxy);
          const bridgePort = this._socksBridge.address().port;
          args.push(`--proxy-server=http://127.0.0.1:${bridgePort}`);
          this.log(`Proxy SOCKS5 con auth: puente local 127.0.0.1:${bridgePort} -> ${proxy.host}:${proxy.port}`);
        } catch (error) {
          this.warn(`No se pudo iniciar el puente SOCKS5 (${error.message}). Se intentará SOCKS5 directo.`);
          args.push(`--proxy-server=socks5://${proxy.host}:${proxy.port}`);
        }
      } else {
        const scheme = proxy.type === 'socks5' ? 'socks5' : 'http';
        args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
        this.log(`Usando proxy ${scheme.toUpperCase()}: ${proxy.host}:${proxy.port}`);
      }
    }

    const executablePath = detectChromeExecutable();
    if (executablePath) {
      this.log(`Chrome detectado: ${executablePath}`);
    } else {
      this.log('Chrome del sistema no encontrado; usando el navegador de Puppeteer.');
    }

    const launch = () => puppeteer.launch({
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      ignoreDefaultArgs: ['--enable-automation'],
      args
    });

    let browser;
    try {
      browser = await launch();
    } catch (error) {
      if (isProfileLockError(error.message)) {
        this.log('⚠️ Chrome ya estaba usando este perfil. Cerrando la instancia previa y reintentando...');
        await closeStaleChrome(profileDir, this.cfg.port, (message) => this.log(message));
        browser = await launch();
      } else {
        throw error;
      }
    }

    // Auto-recuperación: si Chrome se cae o se cierra a mitad de ciclo, se reabre solo.
    browser.on('disconnected', () => {
      if (this._stopping) return;
      this.warn('Chrome se cerró/desconectó inesperadamente.');
      this.closeSocksBridge();
      this.browser = null;
      this.page = null;
      if (this.started && !this.paused) this.recoverBrowser();
    });

    const page = await browser.newPage();

    // Detección de rate-limit/bloqueo por HTTP en el documento principal (403/429/5xx)
    page.on('response', (response) => {
      try {
        if (response.frame() !== page.mainFrame()) return;
        const status = response.status();
        if (status === 403 || status === 429 || status >= 500) {
          this._httpBlock = { status, url: response.url(), at: Date.now() };
        } else if (status >= 200 && status < 400) {
          this._httpBlock = null;
          this._httpRateCount = 0;
        }
      } catch (_) {}
    });

    if (proxy && proxy.host && proxy.type !== 'socks5' && proxy.username !== undefined && proxy.password !== undefined) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
      this.log('Auth del proxy configurada.');
    }

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    const client = await page.target().createCDPSession();
    await client.send('Emulation.setLocaleOverride', { locale: 'en-US' });

    // Ubicacion coherente con el proxy (timezone + geolocalizacion)
    let geo = null;
    if (proxy && proxy.host) {
      geo = await resolveProxyGeo(browser, proxy).catch(() => null);
    }
    const timezone = (geo && geo.timezone) || 'America/Toronto';
    const latitude = geo && Number.isFinite(geo.lat) ? geo.lat : 45.5052;
    const longitude = geo && Number.isFinite(geo.lon) ? geo.lon : -73.5557;
    if (geo) this.log(`🌍 Ubicacion del proxy: ${geo.city || '?'}, ${geo.country || '?'} (${timezone})`);
    await client.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
    await page.setGeolocation({ latitude, longitude, accuracy: 100 });
    await page.setBypassCSP(true);

    const chromeVersion = await browser.version().catch(() => '');
    const chromeMajor = (String(chromeVersion).match(/(\d+)/) || [])[1] || '140';
    const device = devicePreset(this.cfg.device, chromeMajor);
    this.log(`Dispositivo: ${device.kind === 'android' ? `${device.model} (Chrome ${chromeMajor})` : 'iPhone (Safari)'}`);
    await page.emulate({
      userAgent: device.userAgent,
      viewport: device.viewport
    });

    // Anti-deteccion: oculta automatizacion y enmascara la huella por perfil.
    const seed = String(this.id);
    const deviceKind = device.kind;
    await page.evaluateOnNewDocument((seedStr, kind, major, model, platformName, androidVersion) => {
      let s = 2166136261 >>> 0;
      for (let i = 0; i < seedStr.length; i++) { s ^= seedStr.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
      for (let i = 0; i < 5; i++) s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];

      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (_) {}

      // Coherencia con el dispositivo: los moviles no tienen plugins y Safari no tiene window.chrome.
      try { Object.defineProperty(navigator, 'plugins', { get: () => [] }); } catch (_) {}
      try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (_) {}
      try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }); } catch (_) {}
      try { Object.defineProperty(navigator, 'platform', { get: () => (kind === 'android' ? 'Linux armv8l' : 'iPhone') }); } catch (_) {}
      try { Object.defineProperty(navigator, 'vendor', { get: () => (kind === 'android' ? 'Google Inc.' : 'Apple Computer, Inc.') }); } catch (_) {}

      if (kind === 'android') {
        try {
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = {};
        } catch (_) {}
      } else {
        try { delete window.chrome; } catch (_) {}
      }

      // userAgentData coherente (Chrome Android lo tiene; Safari no)
      try {
        if (kind === 'android') {
          const brands = [
            { brand: 'Not?A_Brand', version: '24' },
            { brand: 'Chromium', version: String(major) },
            { brand: 'Google Chrome', version: String(major) }
          ];
          const plat = String(platformName || 'Android');
          const mdl = String(model || 'Pixel 10');
          const pver = String(androidVersion || '16.0.0');
          const data = {
            brands,
            mobile: true,
            platform: plat,
            getHighEntropyValues: () => Promise.resolve({
              architecture: '', bitness: '', brands,
              fullVersionList: brands.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` })),
              mobile: true, model: mdl, platform: plat, platformVersion: pver,
              uaFullVersion: `${major}.0.0.0`
            })
          };
          Object.defineProperty(navigator, 'userAgentData', { get: () => data });
        } else {
          try { delete navigator.userAgentData; } catch (_) {}
        }
      } catch (_) {}

      try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => pick([4, 6, 8]) }); } catch (_) {}
      try { Object.defineProperty(navigator, 'deviceMemory', { get: () => pick([4, 8]) }); } catch (_) {}

      // WebGL coherente con el dispositivo (y variado por perfil en Android).
      try {
        const gpu = kind === 'android'
          ? pick([
            { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 650, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G78 MP20, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G77 MP11, OpenGL ES 3.2)' }
          ])
          : { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
        const patchGL = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return gpu.vendor;
            if (p === 37446) return gpu.renderer;
            return orig.apply(this, arguments);
          };
        };
        patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
        patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
      } catch (_) {}

      // Canvas: ruido determinista (salvo el canvas del captcha)
      try {
        const origGet = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function () {
          const data = origGet.apply(this, arguments);
          try {
            const cv = this.canvas;
            if (cv && cv.getAttribute && cv.getAttribute('data-momonga-skip') === '1') return data;
            const d = data.data;
            if (d.length >= 4) {
              const idx = Math.floor(rand() * (d.length / 4)) * 4;
              d[idx] = (d[idx] + Math.floor(rand() * 3) - 1 + 256) % 256;
            }
          } catch (_) {}
          return data;
        };
      } catch (_) {}

      try {
        const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
        AnalyserNode.prototype.getFloatFrequencyData = function (array) {
          origGetFloat.apply(this, arguments);
          try { if (array && array.length) array[0] = array[0] + rand() * 0.0000001; } catch (_) {}
        };
      } catch (_) {}
    }, seed, deviceKind, chromeMajor, device.model, device.platform, device.androidVersion);

    const fp = await page.evaluate(() => ({
      ua: navigator.userAgent,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: navigator.language
    }));
    this.log(`Fingerprint: TZ=${fp.tz} | Lang=${fp.lang}`);

    return { browser, page };
  }

  async recoverBrowser() {
    if (this._recovering) return;
    this._recovering = true;
    try {
      this.warn('♻️ Reintentando abrir el navegador automáticamente...');
      for (let attempt = 1; attempt <= 3 && this.started && !this.paused; attempt++) {
        await sleep(8000);
        const ok = await this.open().catch(() => false);
        if (ok) {
          this.log('✅ Navegador recuperado; continúo el ciclo.');
          this.noteOk();
          if (this.started && !this.paused) {
            this.scheduleNext();
            this.scheduleRepost();
          }
          return;
        }
        this.warn(`No se pudo reabrir el navegador (intento ${attempt}/3).`);
      }
    } finally {
      this._recovering = false;
    }
  }

  async open() {
    if (this._openPromise) return this._openPromise;
    this._openPromise = this._openInternal().finally(() => {
      this._openPromise = null;
    });
    return this._openPromise;
  }

  async _openInternal() {
    if (this.browser) {
      this.log('La página ya está abierta.');
      return true;
    }

    this.setCycleStage('opening', 'Abriendo navegador.');

    const proxyCheck = await validateProxy(this.cfg.proxy);
    if (!proxyCheck.skipped) {
      if (proxyCheck.ok) {
        this.log(`✅ Proxy OK (IP: ${proxyCheck.ip || 'desconocida'}).`);
      } else {
        this.log(`❌ Proxy no responde (${proxyCheck.reason}). Arranque cancelado para no gastar ciclos.`);
        notify(`❌ Proxy no responde en "${this.id}": ${proxyCheck.reason}`);
        return false;
      }
    }

    try {
      const { browser, page } = await this.launchProfile();
      this.browser = browser;
      this.page = page;
      this.log('Navegador abierto.');
      const urls = siteUrls(this);
      this.log(`Conectando a ${urls.manage}...`);
      await page.goto(urls.manage, {
        waitUntil: 'networkidle2',
        timeout: 90000
      });
      this.log('¡Página cargada con éxito!');

      // Fuerza el zoom de la página a 100% (por si quedó con zoom de una sesión anterior)
      try {
        await page.keyboard.down('Control');
        await page.keyboard.press('Digit0');
        await page.keyboard.up('Control');
      } catch (_) {}

      if (await checkForBlock(page, this, { skipLoginCheck: true })) return false;

      await ensureSession(page, this);
      const stillClosed = await page.evaluate(() => {
        const hasLoginFields = Boolean(document.querySelector('input[type="password"], input[type="email"]'));
        return hasLoginFields && /login|sign in|session expired|sesión/i.test(document.body?.innerText || '');
      }).catch(() => false);
      if (stillClosed) {
        this.setCycleStage('error', 'Sesión cerrada; inicia sesión manualmente.');
        this.log('❌ La sesión está cerrada y no se pudo re-loguear (revisa las credenciales del perfil).');
        this.emitState('error');
        return false;
      }

      await loginIfNeeded(page, this);
      if (await checkForBlock(page, this, { skipLoginCheck: true })) return false;
      this.log('Página lista. Pulsa Iniciar para comenzar el conteo.');
      this.setCycleStage('ready', 'Página lista.');
      this.emitState('ready');
      this.emitActive();
      return true;
    } catch (error) {
      this.log(`Error crítico: ${error.message}`);
      notify(`❌ Error crítico en "${this.id}": ${error.message}`);
      await this.stop();
      return false;
    }
  }

  async start() {
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startInternal().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _startInternal() {
    if (this.started) {
      if (this.paused) {
        this.resume();
      } else {
        this.log('Ya está en ejecución.');
      }
      return;
    }

    if (!this.browser) {
      const opened = await this.open();
      if (!opened) return;
    }

    this.started = true;
    this.paused = false;

    if (this.settings.publishOnStart) {
      this.log('Publicación al iniciar activada.');
      let startOk = false;
      try {
        if (this.settings.rotateAds) {
          startOk = await bumpAllAdsOneByOne(this.page, this);
        } else {
          startOk = await performBump(this.page, this);
        }
      } catch (error) {
        this.warn(`⚠️ La publicación al iniciar falló (${error.message}). El conteo continúa.`);
      }
      this.recordCycleResult(startOk);
    }

    this.setCycleStage('running', 'Conteo automático activo.');

    this.startCountdown();
    this.scheduleNext();
    this.scheduleRepost();
    this.startBlockWatch();
    this.emitActive();
    this.emitState('running');
    saveState();
  }

  startBlockWatch() {
    if (this._blockWatch) clearInterval(this._blockWatch);
    this._blockWatch = setInterval(async () => {
      if (this.started && !this.paused && this.browser && this.page) {
        try {
          await checkForBlock(this.page, this);
        } catch (error) {
          if (isNetworkError(error)) this.warn(`🌐 Sin internet (vigilancia): ${error.message}`);
        }
      }
    }, 45000);
    if (this._blockWatch.unref) this._blockWatch.unref();
  }

  pause() {
    if (!this.started) return;
    this.paused = true;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    if (this._repostTimer) clearTimeout(this._repostTimer);
    if (this._blockWatch) clearInterval(this._blockWatch);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    this._blockWatch = null;
    this.log('⏸ Pausado.');
    io.emit('timer', { id: this.id, time: null });
    io.emit('repost-timer', { id: this.id, time: null });
    this.emitState('paused');
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.log('▶ Reanudado.');
    this.startCountdown();
    this.scheduleNext();
    this.scheduleRepost();
    this.startBlockWatch();
    this.emitState('running');
  }

  async stop() {
    this.started = false;
    this.paused = false;
    this._stopping = true;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    if (this._repostTimer) clearTimeout(this._repostTimer);
    if (this._blockWatch) clearInterval(this._blockWatch);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    this._blockWatch = null;
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.closeSocksBridge();
    this.browser = null;
    this.page = null;
    this._stopping = false;
    this.setCycleStage('idle', 'Perfil detenido.');
    this.log('🛑 Detenido.');
    this.emitActive();
    io.emit('timer', { id: this.id, time: null });
    io.emit('repost-timer', { id: this.id, time: null });
    this.emitState('stopped');
    saveState();
  }

  startCountdown() {
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    this._countdownTimer = setInterval(() => {
      if (!this.started || this.paused) return;
      const remaining = Math.max(0, this._nextBumpAt - Date.now());
      io.emit('timer', { id: this.id, time: mmss(remaining) });

      const repostRemaining = this.autoRepostActive ? Math.max(0, this._nextRepostAt - Date.now()) : null;
      io.emit('repost-timer', { id: this.id, time: repostRemaining === null ? null : hhmmss(repostRemaining) });
    }, 1000);
  }

  scheduleNext() {
    if (!this.started || this.paused) return;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);

    const min = Math.max(1, this.cfg.bumpMinMinutes || this.cfg.intervalMinutes || 16);
    const max = Math.max(min, this.cfg.bumpMaxMinutes || min);

    // Exacto igual que la extensión: obtenerIntervaloAleatorio() — siempre dentro del rango configurado
    const minMs = min * 60 * 1000;
    const maxMs = max * 60 * 1000;
    // Con "Intervalo variable entre ciclos" activado: varia dentro del rango.
    // Desactivado: usa EXACTO el minimo. En ningun caso pasa del maximo.
    const waitMs = this.settings.randomizedDelay
      ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
      : minMs;

    this._nextBumpAt = Date.now() + waitMs;
    const minutes = Math.round(waitMs / 60000);
    this.log(`Próximo bump en ~${minutes} min (rango ${min}–${max} min).`);
    io.emit('timer', { id: this.id, time: mmss(waitMs) });

    this._cycleTimer = setTimeout(() => this.bumpCycle(), waitMs);
  }

  // Reintento corto (por ejemplo, tras perder internet) sin esperar el intervalo completo.
  scheduleRetrySoon(minutes = 2) {
    if (!this.started || this.paused) return;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    const waitMs = Math.max(1, Number(minutes) || 2) * 60 * 1000;
    this._nextBumpAt = Date.now() + waitMs;
    this.log(`🔁 Reintento en ~${Math.round(waitMs / 60000)} min.`);
    io.emit('timer', { id: this.id, time: mmss(waitMs) });
    this._cycleTimer = setTimeout(() => this.bumpCycle(), waitMs);
  }

  async bumpCycle() {
    if (this.limits.dailyLimit > 0 && this.stats.bumpsToday >= this.limits.dailyLimit) {
      this.log(`⛔ Tope diario alcanzado (${this.stats.bumpsToday}/${this.limits.dailyLimit}). No publico más hoy.`);
      this.scheduleNext();
      return;
    }
    if (this._operationPromise) {
      this.log('Ciclo de bump omitido: hay una publicación en curso. Se reprograma.');
      this.scheduleNext();
      return;
    }
    this._operationPromise = this._bumpCycleInternal();
    try {
      await this._operationPromise;
    } catch (error) {
      const netErr = isNetworkError(error);
      if (netErr) {
        this.warn(`🌐 Sin internet o conexión perdida (${error.message}). Reintento en 2 min.`);
      } else {
        this.warn(`⚠️ El ciclo falló (${error.message}). Se reprograma.`);
      }
      if (this.started && !this.paused) {
        if (netErr) this.scheduleRetrySoon(2);
        else this.scheduleNext();
      }
    } finally {
      this._operationPromise = null;
    }
  }

  async _bumpCycleInternal() {
    if (!this.started || this.paused) return;
    this.log('Iniciando ciclo de bump...');

    const risk = assessComplianceRisk(this);
    if (risk.length > 0) warnComplianceRisk(this, risk);

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      this.log('Recarga completada.');
    } catch (error) {
      this.log(`Recarga fallida: ${error.message}`);
    }

    // Revisa la sesión antes de operar; si murió, re-loguea.
    await ensureSession(this.page, this);
    if (await checkForBlock(this.page, this)) {
      // Si fue un rate-limit (no paró todo), reprograma para reintentar.
      if (this.started && !this.paused) this.scheduleNext();
      return;
    }

    let ok = false;
    if (this.settings.rotateAds) {
      ok = await bumpAllAdsOneByOne(this.page, this);
    } else {
      ok = await performBump(this.page, this);
    }
    this.recordCycleResult(ok);
    this.log('Ciclo completado.');

    this.scheduleNext();
  }

  setAutoRepost(active, minutes) {
    this.autoRepostActive = Boolean(active);
    if (minutes !== undefined && minutes !== null && minutes !== '') {
      const val = Math.max(1, Math.round(Number(minutes) || this.repostIntervalMin || 360));
      this.repostIntervalMin = val;
      this.repostInterval = Math.round(val / 60) || 1;
      this.cfg.repostIntervalMin = val;
    }
    if (this._repostTimer) {
      clearTimeout(this._repostTimer);
      this._repostTimer = null;
    }
    if (this.autoRepostActive && this.started && !this.paused) {
      this.scheduleRepost();
    } else if (!this.autoRepostActive) {
      io.emit('repost-timer', { id: this.id, time: null });
    }
  }

  scheduleRepost() {
    if (!this.started || this.paused || !this.autoRepostActive) return;
    if (this._repostTimer) clearTimeout(this._repostTimer);

    const minutes = Math.max(1, Math.round(this.repostIntervalMin || this.repostInterval * 60));
    const waitMs = minutes * 60 * 1000;
    this._nextRepostAt = Date.now() + waitMs;
    this.log(`🔄 Ciclo de borrado/republicación en ${minutes} min.`);
    io.emit('repost-timer', { id: this.id, time: hhmmss(waitMs) });
    this._repostTimer = setTimeout(() => this.repostCycle(), waitMs);
  }

  async repostCycle() {
    if (!this.started || this.paused || !this.autoRepostActive) return;
    if (this.limits.dailyLimit > 0 && this.stats.bumpsToday >= this.limits.dailyLimit) {
      this.log(`⛔ Tope diario alcanzado (${this.stats.bumpsToday}/${this.limits.dailyLimit}). No republico más hoy.`);
      this.scheduleRepost();
      return;
    }
    if (this._operationPromise) {
      this.log('Republicación omitida: hay una publicación en curso. Se reprograma.');
      this.scheduleRepost();
      return;
    }

    // Evita que el temporizador de bump dispare mientras se remueve/republica el post.
    if (this._cycleTimer) {
      clearTimeout(this._cycleTimer);
      this._cycleTimer = null;
    }

    const risk = assessComplianceRisk(this);
    if (risk.length > 0) warnComplianceRisk(this, risk);

    this.log('🔄 Iniciando ciclo automático de borrado y republicación...');
    let ok = false;
    this._operationPromise = deleteAndRepost(this.page, this).then((r) => { ok = r; });
    try {
      await this._operationPromise;
    } catch (error) {
      const netErr = isNetworkError(error);
      if (netErr) {
        this.warn(`🌐 Sin internet o conexión perdida en republicación (${error.message}). Reintento en 2 min.`);
      } else {
        this.warn(`⚠️ La republicación falló (${error.message}). Se reprograma.`);
      }
      this.recordCycleResult(false);
      if (this.started && !this.paused) {
        this.scheduleNext();
        if (this.autoRepostActive) this.scheduleRetrySoon(2);
      }
      return;
    } finally {
      this._operationPromise = null;
    }
    this.recordCycleResult(ok);

    // Tras el repost, reprograma ambos ciclos para que no queden desincronizados.
    if (this.started && !this.paused) {
      this.scheduleNext();
      if (this.autoRepostActive) this.scheduleRepost();
    }
  }

  async publishNow() {
    if (!this.started) {
      this.log('Primero inicia el perfil para poder publicar.');
      return;
    }
    if (this._operationPromise) {
      this.log('Publicación manual omitida: ya hay una publicación en curso.');
      return;
    }

    this._operationPromise = this._publishNowInternal();
    try {
      await this._operationPromise;
    } catch (error) {
      this.warn(isNetworkError(error) ? `🌐 Sin internet al publicar (${error.message}). Se reprograma.` : `⚠️ La publicación falló (${error.message}). Se reprograma.`);
      if (this.started && !this.paused) this.scheduleNext();
    } finally {
      this._operationPromise = null;
    }
  }

  async retryCycle() {
    if (!this.page) {
      this.log('Reintento disponible después de abrir el navegador.');
      return;
    }
    if (this.paused) {
      this.log('Reintento no disponible mientras el perfil está pausado.');
      return;
    }
    if (this._operationPromise) {
      this.log('Reintento omitido: ya hay una operación en curso.');
      return;
    }

    const wasStarted = this.started;
    if (!this.started) {
      this.started = true;
      this.startCountdown();
      this.emitActive();
      this.emitState('running');
    }

    this._operationPromise = deleteAndRepost(this.page, this, { resume: true });
    try {
      await this._operationPromise;
    } catch (error) {
      this.warn(isNetworkError(error) ? `🌐 Sin internet al reintentar (${error.message}). Se reprograma.` : `⚠️ El reintento falló (${error.message}). Se reprograma.`);
    } finally {
      this._operationPromise = null;
    }
    if (this.started && !this.paused) this.scheduleNext();
    if (!wasStarted && this.started) saveState();
  }

  async _publishNowInternal() {

    this.log('📢 Publicación manual solicitada...');

    const risk = assessComplianceRisk(this);
    if (risk.length > 0) warnComplianceRisk(this, risk);

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      this.log('Recarga completada.');
    } catch (error) {
      this.log(`Recarga fallida: ${error.message}`);
    }

    // Revisa la sesión antes de operar; si murió, re-loguea.
    await ensureSession(this.page, this);
    if (await checkForBlock(this.page, this)) {
      // Si fue un rate-limit (no paró todo), reprograma para reintentar.
      if (this.started && !this.paused) this.scheduleNext();
      return;
    }

    if (this.settings.rotateAds) {
      await bumpAllAdsOneByOne(this.page, this);
    } else {
      await performBump(this.page, this);
    }

    this.log('Publicación manual completada.');

    if (!this.paused) {
      this.scheduleNext();
    }
  }
}

let controllers = new Map();

function buildControllers() {
  controllers = new Map();
  try {
    const config = loadConfig();
    const state = loadState();
    const today = todayKey();
    for (const profile of config) {
      const controller = new ProfileController(profile);
      const saved = state[profile.id];
      if (saved && saved.stats) {
        controller.stats = { ...controller.stats, ...saved.stats };
        if (controller.stats.date !== today) {
          controller.stats.date = today;
          controller.stats.bumpsToday = 0;
        }
      }
      if (saved) {
        controller.cycleStage = saved.cycleStage || controller.cycleStage;
        controller.cycleDetail = saved.cycleDetail || '';
        controller.cycleUpdatedAt = Number(saved.cycleUpdatedAt) || 0;
        controller.cycleDeleteCompleted = Boolean(saved.cycleDeleteCompleted);
        controller.rotateQueue = Array.isArray(saved.rotateQueue) ? saved.rotateQueue : [];
        controller.variantIndex = (saved.variantIndex && typeof saved.variantIndex === 'object') ? saved.variantIndex : {};
      }
      controllers.set(profile.id, controller);
    }
    return config;
  } catch (error) {
    console.error(error.message);
    return [];
  }
}

buildControllers();

async function restoreActiveProfiles() {
  if (process.env.AUTO_START !== '1') return;

  const state = loadState();
  const ids = Object.keys(state).filter(id => state[id] && state[id].active && controllers.has(id));
  if (ids.length === 0) return;

  console.log(`♻️ Reanudando ${ids.length} perfil(es) que estaban activos...`);
  for (const id of ids) {
    const controller = controllers.get(id);
    controller.log('♻️ Auto-arranque tras reinicio del servidor.');
    controller.start().catch((error) => controller.log(`Auto-arranque falló: ${error.message}`));
    await sleep(3000);
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    profiles: [...controllers.values()].map((c) => c.healthSnapshot()),
    twoCaptcha: {
      solves: twoCaptchaStats.solves,
      fails: twoCaptchaStats.fails,
      balance: twoCaptchaStats.balance,
      lastBalanceAt: twoCaptchaStats.lastBalanceAt
    },
    at: Date.now()
  });
});

app.post('/api/health/balance', async (req, res) => {
  await refreshTwoCaptchaBalance();
  res.json({ success: true, ...twoCaptchaStats });
});

app.get('/api/notifications', (req, res) => {
  const cfg = loadNotifyConfig();
  res.json({
    telegramToken: cfg.telegramToken || process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: cfg.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
    discordWebhook: cfg.discordWebhook || process.env.DISCORD_WEBHOOK_URL || ''
  });
});

app.post('/api/notifications', (req, res) => {
  try {
    const cfg = {
      telegramToken: String(req.body?.telegramToken || '').trim(),
      telegramChatId: String(req.body?.telegramChatId || '').trim(),
      discordWebhook: String(req.body?.discordWebhook || '').trim()
    };
    saveNotifyConfig(cfg);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/notifications/test', async (req, res) => {
  try {
    const cfg = {
      telegramToken: String(req.body?.telegramToken || '').trim(),
      telegramChatId: String(req.body?.telegramChatId || '').trim(),
      discordWebhook: String(req.body?.discordWebhook || '').trim()
    };
    if (cfg.telegramToken || cfg.discordWebhook) saveNotifyConfig(cfg);

    const tgToken = cfg.telegramToken;
    const tgChat = cfg.telegramChatId;
    if (tgToken && tgChat) {
      const r = await undiciFetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: 'MOMONGA PRO\n✅ Prueba de notificación. ¡Funciona!' })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        return res.status(400).json({ success: false, error: data.description || `Telegram respondió ${r.status}` });
      }
      return res.json({ success: true, message: 'Enviado a Telegram.' });
    }

    if (cfg.discordWebhook) {
      await notify('✅ Prueba de notificación.');
      return res.json({ success: true, message: 'Enviado a Discord.' });
    }

    res.status(400).json({ success: false, error: 'Falta el token y el chat ID de Telegram.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/profiles', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profiles/export', (req, res) => {
  try {
    const config = loadConfig();
    res.setHeader('Content-Disposition', 'attachment; filename="momonga-perfiles.json"');
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/profiles/import', (req, res) => {
  try {
    const incoming = req.body?.profiles;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'El archivo no contiene perfiles válidos.' });
    }
    const config = loadConfig();
    let added = 0;
    let updated = 0;
    for (const raw of incoming) {
      const id = String(raw?.id || '').trim();
      if (!id) continue;
      const clean = { ...raw, id };
      const idx = config.findIndex((item) => item.id === id);
      if (idx >= 0) {
        config[idx] = clean;
        updated += 1;
      } else {
        config.push(clean);
        added += 1;
      }
      const existing = controllers.get(id);
      if (existing) existing.cfg = clean;
      else controllers.set(id, new ProfileController(clean));
    }
    saveConfig(config);
    io.emit('profiles-updated', config);
    res.json({ success: true, added, updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/profiles', (req, res) => {
  try {
    const { id, port, intervalMinutes, bumpMinMinutes, bumpMaxMinutes, url, email, password, supportEmail, supportUrl, proxy, adDetails, limits, device } = req.body || {};
    const cleanId = String(id || '').trim();
    const numericPort = Number(port);
    let minVal = Number(bumpMinMinutes);
    let maxVal = Number(bumpMaxMinutes);
    if (!Number.isFinite(minVal) || minVal < 1) minVal = Number(intervalMinutes) || 16;
    if (!Number.isFinite(maxVal) || maxVal < 1) maxVal = minVal;
    minVal = Math.min(10080, Math.round(minVal));
    maxVal = Math.min(10080, Math.max(Math.round(maxVal), minVal));

    if (!cleanId || !Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) {
      return res.status(400).json({ error: 'El nombre y el puerto válido son obligatorios.' });
    }
    if (minVal < 1) {
      return res.status(400).json({ error: 'El intervalo debe ser de al menos 1 minuto.' });
    }

    const config = loadConfig();
    if (config.some(profile => profile.id === cleanId)) {
      return res.status(409).json({ error: 'Ya existe un navegador con ese nombre.' });
    }
    if (config.some(profile => Number(profile.port) === numericPort)) {
      return res.status(409).json({ error: 'Ese puerto ya está en uso por otro navegador.' });
    }

    const newProfile = {
      id: cleanId,
      port: numericPort,
      email: String(email || '').trim(),
      password: String(password || ''),
      supportEmail: String(supportEmail || '').trim(),
      supportUrl: String(supportUrl || '').trim(),
      intervalMinutes: minVal,
      bumpMinMinutes: minVal,
      bumpMaxMinutes: maxVal,
      url: String(url || DEFAULT_URL).trim() || DEFAULT_URL,
      device: ['iphone', 'android', 'pixel', 'pixel_pro', 'samsung', 'samsung_ultra'].includes(device) ? device : 'iphone',
      adDetails: {
        name: String(adDetails?.name || '').trim(),
        headline: String(adDetails?.headline || '').trim(),
        city: String(adDetails?.city || '').trim(),
        age: String(adDetails?.age || '').trim(),
        location: String(adDetails?.location || '').trim(),
        phone: String(adDetails?.phone || '').trim(),
        text: String(adDetails?.text || ''),
        textVariants: Array.isArray(adDetails?.textVariants) ? adDetails.textVariants.map((v) => String(v || '')).filter((v) => v.trim()) : [],
        headlineVariants: Array.isArray(adDetails?.headlineVariants) ? adDetails.headlineVariants.map((v) => String(v || '')).filter((v) => v.trim()) : [],
        photosPath: String(adDetails?.photosPath || '').trim()
      },
      limits: {
        dailyLimit: Math.max(0, Math.round(Number(limits?.dailyLimit) || 0)),
        conservativeMode: Boolean(limits?.conservativeMode)
      }
    };

    if (proxy && proxy.host) {
      newProfile.proxy = {
        host: String(proxy.host).trim(),
        port: Number(proxy.port),
        username: String(proxy.username || ''),
        password: String(proxy.password || ''),
        type: proxy.type === 'socks5' ? 'socks5' : 'http'
      };
    }

    config.push(newProfile);
    saveConfig(config);
    controllers.set(newProfile.id, new ProfileController(newProfile));
    io.emit('profiles-updated', config);
    res.status(201).json(newProfile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/profiles/:id/settings', (req, res) => {
  try {
    const config = loadConfig();
    const profile = config.find(item => item.id === req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });

    const body = req.body || {};

    if ('rotateAds' in body || 'randomizedDelay' in body || 'publishOnStart' in body) {
      profile.settings = {
        rotateAds: 'rotateAds' in body ? Boolean(body.rotateAds) : Boolean(profile.settings?.rotateAds),
        randomizedDelay: 'randomizedDelay' in body ? Boolean(body.randomizedDelay) : Boolean(profile.settings?.randomizedDelay),
        publishOnStart: 'publishOnStart' in body ? Boolean(body.publishOnStart) : Boolean(profile.settings?.publishOnStart)
      };
    }

    if ('apiKey2Captcha' in body) {
      profile.apiKey2Captcha = String(body.apiKey2Captcha || '').trim();
    }

    if ('device' in body) {
      profile.device = ['iphone', 'android', 'pixel', 'pixel_pro', 'samsung', 'samsung_ultra'].includes(body.device) ? body.device : 'iphone';
      const ctrl = controllers.get(profile.id);
      if (ctrl) ctrl.cfg.device = profile.device;
    }

    if ('email' in body) {
      profile.email = String(body.email || '').trim();
    }

    if ('password' in body) {
      profile.password = String(body.password || '');
    }

    if ('supportEmail' in body) {
      profile.supportEmail = String(body.supportEmail || '').trim();
    }

    if ('supportUrl' in body) {
      profile.supportUrl = String(body.supportUrl || '').trim();
    }

    if ('autoAppeal' in body) {
      profile.autoAppeal = Boolean(body.autoAppeal);
    }

    if (body.limits && typeof body.limits === 'object') {
      profile.limits = {
        dailyLimit: Math.max(0, Math.round(Number(body.limits.dailyLimit) || 0)),
        conservativeMode: Boolean(body.limits.conservativeMode)
      };
    }

    if (body.adDetails && typeof body.adDetails === 'object') {
      const normVariants = (value, fallback) => {
        if (Array.isArray(value)) return value.map((v) => String(v || '')).filter((v) => v.trim());
        if (value !== undefined) return [];
        return Array.isArray(fallback) ? fallback : [];
      };
      profile.adDetails = {
        name: String(body.adDetails.name || '').trim(),
        headline: String(body.adDetails.headline || '').trim(),
        city: String(body.adDetails.city || '').trim(),
        age: String(body.adDetails.age || '').trim(),
        location: String(body.adDetails.location || '').trim(),
        phone: String(body.adDetails.phone || '').trim(),
        text: String(body.adDetails.text || ''),
        textVariants: normVariants(body.adDetails.textVariants, profile.adDetails?.textVariants),
        headlineVariants: normVariants(body.adDetails.headlineVariants, profile.adDetails?.headlineVariants),
        photosPath: String(body.adDetails.photosPath || '').trim()
      };
    }

    if ('proxy' in body) {
      const parsed = parseProxy(body.proxy);
      if (!parsed) {
        delete profile.proxy;
      } else {
        profile.proxy = parsed;
      }
    }

    saveConfig(config);

    const controller = controllers.get(profile.id);
    if (controller) {
      controller.cfg = profile;
      if (profile.settings) controller.settings = profile.settings;
      if (profile.limits) {
        controller.limits = {
          dailyLimit: Math.max(0, Math.round(Number(profile.limits.dailyLimit) || 0)),
          conservativeMode: Boolean(profile.limits.conservativeMode)
        };
      }
    }
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/profiles/:id/scrape', async (req, res) => {
  const controller = controllers.get(req.params.id);
  if (!controller || !controller.page) {
    return res.status(400).json({ success: false, error: 'Inicia el navegador de ese perfil para copiar sus datos.' });
  }

  try {
    try {
      fs.writeFileSync(path.join(LOGS_DIR, `dump-${controller.id}.html`), await controller.page.content(), 'utf8');
    } catch (_) {}

    let data = await scrapeActiveAdData(controller.page);

    if (!data.city && !data.text) {
      const textData = await scrapeActiveAdFromText(controller.page);
      data = {
        ...data,
        phone: data.phone || textData.phone,
        age: data.age || textData.age,
        city: data.city || textData.city,
        location: data.location || textData.location,
        headline: data.headline || textData.headline
      };
    }

    controller.log(`📥 Leído de la página actual -> ciudad: "${data.city}", edad: "${data.age}", texto: ${data.text ? data.text.length + ' caracteres' : 'vacío'}`);

    if (!data.city && !data.text) {
      const fields = await controller.page.evaluate(() => Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => el.type !== 'password')
        .map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type, name: el.name, id: el.id })));
      controller.log('🔎 Campos disponibles: ' + JSON.stringify(fields));
      controller.log('⚠️ No se encontraron campos de ciudad/texto. Abre el formulario del anuncio (Editar) o la página del anuncio en la ventana del perfil y vuelve a intentar.');
    }

    const photoUrls = (data.city || data.text) ? await scrapeActiveAdPhotos(controller.page) : [];
    let photosPath = '';
    let photosSaved = 0;

    if (photoUrls.length > 0) {
      const targetDir = path.join(__dirname, 'profiles', controller.id, 'photos');
      const dispatcher = buildProxyDispatcher(controller.cfg.proxy);
      controller.log(`🖼️ Descargando y limpiando ${photoUrls.length} foto(s)${dispatcher ? ' vía proxy' : ''}...`);
      try {
        // Reemplazar: borrar las fotos anteriores para dejar SOLO las del anuncio actual
        if (fs.existsSync(targetDir)) {
          for (const name of fs.readdirSync(targetDir)) {
            try { fs.unlinkSync(path.join(targetDir, name)); } catch (_) {}
          }
        }
        for (const url of photoUrls) {
          const saved = await downloadAndSanitizePhoto(url, targetDir, controller.id, dispatcher);
          if (saved) photosSaved++;
        }
      } finally {
        if (dispatcher) await dispatcher.close().catch(() => {});
      }
      if (photosSaved > 0) {
        photosPath = `profiles/${controller.id}/photos`;
        controller.log(`🛡️ ${photosSaved} foto(s) blindada(s) en ${photosPath}.`);
      }
    }

    res.json({ success: true, data: { ...data, photosPath, photosSaved } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Borra las carpetas de un perfil (Chrome + fotos), con proteccion anti path-traversal.
function removeProfileFolders(id) {
  const base = path.resolve(path.join(__dirname, 'profiles'));
  for (const name of [`perfil_${id}`, String(id)]) {
    const dir = path.resolve(base, name);
    if (dir === base || !dir.startsWith(base + path.sep)) continue;
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`No se pudo borrar la carpeta "${name}": ${error.message}`);
    }
  }
}

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const config = loadConfig();
    const index = config.findIndex(item => item.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });

    const controller = controllers.get(req.params.id);
    if (controller) {
      await controller.stop();
      controllers.delete(req.params.id);
    }

    config.splice(index, 1);
    saveConfig(config);
    removeProfileFolders(req.params.id);
    io.emit('profiles-updated', config);
    saveState();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/profiles/:id/rename', async (req, res) => {
  try {
    const oldId = String(req.params.id || '');
    const newId = String((req.body || {}).newId || '').trim();

    if (!newId) return res.status(400).json({ success: false, error: 'Escribe un nombre.' });
    if (newId === oldId) return res.json({ success: true, id: newId });
    if (/[\\/:*?"<>|]/.test(newId)) {
      return res.status(400).json({ success: false, error: 'El nombre no puede tener estos caracteres: \\ / : * ? " < > |' });
    }

    const config = loadConfig();
    const profile = config.find(item => item.id === oldId);
    if (!profile) return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });
    if (config.some(item => item.id === newId)) {
      return res.status(409).json({ success: false, error: 'Ya existe un navegador con ese nombre.' });
    }

    const controller = controllers.get(oldId);
    if (controller) {
      try { await controller.stop(); } catch (_) {}
      controllers.delete(oldId);
    }

    // Renombra la carpeta de sesión (profiles/perfil_<id>) para no perder el login
    const oldDir = path.join(__dirname, 'profiles', `perfil_${oldId}`);
    const newDir = path.join(__dirname, 'profiles', `perfil_${newId}`);
    try {
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir);
    } catch (error) {
      console.error('No se pudo renombrar la carpeta de perfil:', error.message);
    }

    profile.id = newId;
    saveConfig(config);

    if (controller) {
      controller.cfg = profile;
      controller.id = newId;
      controllers.set(newId, controller);
    } else {
      controllers.set(newId, new ProfileController(profile));
    }

    io.emit('profiles-updated', config);
    saveState();
    res.json({ success: true, id: newId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.patch('/api/profiles/:id/autorepost', (req, res) => {
  try {
    const config = loadConfig();
    const profile = config.find(item => item.id === req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });

    const body = req.body || {};

    if ('autoRepostActive' in body) {
      profile.autoRepostActive = Boolean(body.autoRepostActive);
    }

    if (body.repostInterval !== undefined && body.repostInterval !== null && body.repostInterval !== '') {
      const minutes = Number(body.repostInterval);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) {
        return res.status(400).json({ success: false, error: 'El intervalo debe estar entre 1 y 43200 minutos.' });
      }
      profile.repostIntervalMin = Math.round(minutes);
      profile.repostInterval = Math.round(Number(minutes) / 60) || 1;
    }

    saveConfig(config);

    const controller = controllers.get(profile.id);
    if (controller) {
      controller.cfg = profile;
      controller.setAutoRepost(profile.autoRepostActive, profile.repostIntervalMin || profile.repostInterval * 60);
    }
    res.json({ success: true, autoRepostActive: Boolean(profile.autoRepostActive), repostInterval: Number(profile.repostIntervalMin) || Number(profile.repostInterval) * 60 || 360 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('🔌 Interfaz conectada.');

  for (const c of controllers.values()) {
    io.emit('profile-state', { id: c.id, state: c.state });
    io.emit('stats', { id: c.id, stats: c.stats });
    io.emit('cycle-stage', {
      id: c.id,
      stage: c.cycleStage,
      detail: c.cycleDetail,
      at: c.cycleUpdatedAt
    });
    if (c.started && !c.paused) {
      const remaining = Math.max(0, c._nextBumpAt - Date.now());
      io.emit('timer', { id: c.id, time: mmss(remaining) });
      const repostRemaining = c.autoRepostActive ? Math.max(0, c._nextRepostAt - Date.now()) : null;
      io.emit('repost-timer', { id: c.id, time: repostRemaining === null ? null : hhmmss(repostRemaining) });
    } else {
      io.emit('timer', { id: c.id, time: null });
      io.emit('repost-timer', { id: c.id, time: null });
    }
  }
  let active = 0;
  for (const c of controllers.values()) {
    if (c.browser) active++;
  }
  io.emit('active-count', { active });

  // Arranque escalonado: no abrir todas las cuentas a la vez (evita correlación multicuenta)
  function staggerSeconds() {
    const base = Number(process.env.START_STAGGER_SECONDS) || 45;
    const jitter = 0.6 + Math.random() * 0.8; // 60% - 140%
    return Math.max(5, Math.round(base * jitter));
  }

  function forEachStaggered(action) {
    let acc = 0;
    for (const c of controllers.values()) {
      const wait = acc;
      if (wait === 0) action(c);
      else setTimeout(() => action(c), wait * 1000);
      acc += staggerSeconds();
    }
  }

  socket.on('open-all', () => {
    forEachStaggered((c) => c.open());
  });

  socket.on('open-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.open();
  });

  socket.on('start-all', () => {
    forEachStaggered((c) => c.start());
  });

  socket.on('pause-all', () => {
    for (const c of controllers.values()) c.pause();
  });

  socket.on('publish-all', () => {
    for (const c of controllers.values()) c.publishNow();
  });

  socket.on('start-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.start();
  });

  socket.on('pause-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) {
      if (controller.paused) {
        controller.resume();
      } else {
        controller.pause();
      }
    }
  });

  socket.on('stop-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.stop();
  });

  socket.on('publish-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.publishNow();
  });

  socket.on('retry-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.retryCycle();
  });

  socket.on('appeal-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) createManualAppeal(controller);
  });

  // Abre una URL (soporte/Outlook) en el navegador del perfil bloqueado.
  socket.on('open-in-profile', async (payload) => {
    try {
      const id = String((payload && payload.id) || '');
      const url = String((payload && payload.url) || '');
      const controller = controllers.get(id);
      const ok = await openUrlInProfileBrowser(controller, url);
      if (!ok) openExternalUrl(url);
    } catch (_) {}
  });



  socket.on('update-interval', ({ id, min, max }) => {
    const controller = controllers.get(id);
    if (!controller) return;
    const minVal = Math.max(1, Math.floor(Number(min) || 1));
    const maxVal = Math.max(minVal, Math.floor(Number(max) || minVal));
    const config = loadConfig();
    const profile = config.find(p => p.id === id);
    if (profile) {
      profile.bumpMinMinutes = minVal;
      profile.bumpMaxMinutes = maxVal;
      saveConfig(config);
    }
    Object.assign(controller.cfg, { bumpMinMinutes: minVal, bumpMaxMinutes: maxVal });
    if (controller.started && !controller.paused) controller.scheduleNext();
    controller.log(`⏱️ Intervalo de bumps actualizado: ${minVal}–${maxVal} min.`);
    io.emit('profiles-updated', loadConfig());
  });

  socket.on('update-repost-interval', ({ id, minutes }) => {
    const controller = controllers.get(id);
    if (!controller) return;
    const val = Math.max(1, Math.round(Number(minutes) || 360));
    const config = loadConfig();
    const profile = config.find(p => p.id === id);
    if (profile) {
      profile.repostIntervalMin = val;
      profile.repostInterval = Math.round(val / 60) || 1;
      saveConfig(config);
    }
    Object.assign(controller.cfg, { repostIntervalMin: val, repostInterval: Math.round(val / 60) || 1 });
    if (controller.autoRepostActive && controller.started && !controller.paused) controller.scheduleRepost();
    controller.log(`⏱️ Ciclo de borrado/republicación: ${val} min.`);
  });

});

// --- Salud: saldo de 2Captcha y estado de proxies ---
async function refreshTwoCaptchaBalance() {
  const keys = [...new Set([...controllers.values()].map((c) => c.cfg.apiKey2Captcha).filter((k) => k && !/^AQU[IÍ]/i.test(k)))];
  if (keys.length === 0) return;
  try {
    const res = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/res.php?key=${encodeURIComponent(keys[0])}&action=getbalance&json=1`);
    const data = await res.json();
    if (data.status === 1) {
      twoCaptchaStats.balance = Number(data.request);
      twoCaptchaStats.lastBalanceAt = Date.now();
      if (twoCaptchaStats.balance < 1) {
        for (const c of controllers.values()) {
          if (c.started) c.warn(`Saldo de 2Captcha bajo: $${twoCaptchaStats.balance.toFixed(2)}`);
        }
      }
      io.emit('health', { global: true });
    }
  } catch (_) {
    // sin conexión a 2Captcha
  }
}

async function checkProxiesHealth() {
  for (const controller of controllers.values()) {
    if (!controller.started || controller.paused) continue;
    if (!controller.cfg.proxy || !controller.cfg.proxy.host) continue;
    const result = await validateProxy(controller.cfg.proxy, 10000);
    if (!result.skipped && !result.ok) {
      controller.warn(`Proxy no responde (${result.reason}).`);
    }
  }
}

server.listen(PORT, () => {
  pruneLogs();
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📋 Perfiles cargados: ${controllers.size}`);
  serverLog(`Servidor iniciado en puerto ${PORT} con ${controllers.size} perfil(es).`);
  if (!process.env.PANEL_PASSWORD) {
    console.warn('⚠️ Contraseña del panel por defecto: "momonga". Define PANEL_PASSWORD para cambiarla.');
  }
  restoreActiveProfiles();
  refreshTwoCaptchaBalance();
  setInterval(refreshTwoCaptchaBalance, 30 * 60 * 1000).unref();
  setInterval(checkProxiesHealth, 10 * 60 * 1000).unref();
  startTelegramBot();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error('');
    console.error(`❌ El puerto ${PORT} ya está en uso.`);
    console.error('   Probablemente MOMONGA PRO ya está abierto en otra ventana.');
    console.error('   Cierra esa ventana o cambia el puerto con:  set PORT=3001');
    console.error('');
    logToFile('server', `EADDRINUSE: el puerto ${PORT} ya está en uso.`);
    process.exit(1);
  }

  console.error('❌ Error del servidor:', error.message);
  logToFile('server', `Error del servidor: ${error.message}`);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Excepción no capturada:', error);
  logToFile('server', `uncaughtException: ${error.stack || error.message}`);
  notify(`❌ Excepción no capturada: ${error.message}`);
});

process.on('unhandledRejection', (reason) => {
  const message = reason && reason.message ? reason.message : String(reason);
  console.error('❌ Promesa rechazada sin manejar:', message);
  logToFile('server', `unhandledRejection: ${message}`);
});

process.on('SIGINT', async () => {
  console.log('\nCerrando navegadores...');
  for (const c of controllers.values()) {
    await c.stop();
  }
  process.exit(0);
});