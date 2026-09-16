const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');
const PORT = process.env.PORT || 3000;
const DEFAULT_URL = 'https://megapersonals.eu/';

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

const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'momonga';
const AUTH_COOKIE = 'momonga_auth';
const AUTH_TOKEN = crypto.createHash('sha256').update(`momonga-pro:${PANEL_PASSWORD}`).digest('hex');

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
  if (String(req.body?.password || '') === PANEL_PASSWORD) {
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

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  if (cookies[AUTH_COOKIE] === AUTH_TOKEN) return next();
  next(new Error('unauthorized'));
});

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Falta config.json. Crea el archivo con tus perfiles antes de lanzar el servidor.');
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config) || config.length === 0) {
    throw new Error('config.json debe contener un array de perfiles.');
  }
  return config;
}

const LOGS_DIR = path.join(__dirname, 'logs');

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

async function notify(message) {
  const text = `MOMONGA PRO\n${message}`;
  const tasks = [];

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChat) {
    tasks.push(undiciFetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, text })
    }).catch(() => {}));
  }

  const discord = process.env.DISCORD_WEBHOOK_URL;
  if (discord) {
    tasks.push(undiciFetch(discord, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    }).catch(() => {}));
  }

  await Promise.all(tasks);
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
        cycleDeleteCompleted: Boolean(controller.cycleDeleteCompleted)
      };
    }
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

// Función para resolver CAPTCHAs automáticamente con tu clave de 2Captcha
async function solveCaptcha(apiKey, siteKey, pageUrl, page) {
  try {
    console.log('🤖 Enviando CAPTCHA a 2Captcha...');
    const submitRes = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
    const submitData = await submitRes.json();

    if (submitData.status !== 1) {
      throw new Error(`Error al enviar: ${submitData.request}`);
    }

    const taskId = submitData.request;
    console.log(`⏳ Tarea creada (${taskId}). Esperando resolución de 2Captcha...`);

    for (let i = 0; i < 24; i++) {
      await sleep(5000);

      const res = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
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

        return true;
      }

      if (data.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`Respuesta de error: ${data.request}`);
      }
    }

    throw new Error('Tiempo de espera agotado para el CAPTCHA.');
  } catch (error) {
    console.error(`❌ Error en resolución automática: ${error.message}`);
    return false;
  }
}

async function handleCaptchaIfPresent(page, controller) {
  const siteKey = await detectCaptchaSiteKey(page);
  if (!siteKey) return true;

  const apiKey = controller.cfg.apiKey2Captcha;
  if (!apiKey || /^AQU[IÍ]/i.test(apiKey)) {
    controller.log('CAPTCHA detectado pero falta la clave apiKey2Captcha del perfil en la configuración.');
    return false;
  }

  controller.log('🧩 CAPTCHA detectado. Resolviendo con 2Captcha...');
  const solved = await solveCaptcha(apiKey, siteKey, page.url(), page);
  controller.log(solved ? '✅ CAPTCHA resuelto e inyectado.' : '❌ No se pudo resolver el CAPTCHA.');
  return solved;
}

const BLOCK_PATTERNS = [
  /account[^.]{0,40}(suspended|banned|blocked|disabled)/i,
  /(suspended|banned|blocked|disabled)[^.]{0,40}account/i,
  /access denied/i,
  /cuenta\s+(suspendida|bloqueada|baneada)/i,
  /your account (has been|was) (suspended|banned|blocked|disabled)/i,
  /you (have been|are) (suspended|banned|blocked)/i,
  /\bsuspended\b/i,
  /\bbanned\b/i,
  /\bblocked\b/i
];

let emergencyActive = false;

async function detectBlock(page) {
  try {
    return await page.evaluate((patternsSource) => {
      const patterns = patternsSource.map((source) => new RegExp(source, 'i'));
      const parts = [document.title || ''];

      const selectors = [
        'h1', 'h2', 'h3',
        '[role="alert"]',
        '.alert', '.error', '.error-message', '.notice-error',
        '[class*="alert" i]', '[class*="error" i]', '[class*="suspend" i]', '[class*="banned" i]', '[class*="blocked" i]',
        '[id*="alert" i]', '[id*="error" i]', '[id*="suspend" i]', '[id*="banned" i]'
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
  console.error('\x1b[41m\x1b[1m\x1b[37m' + ' 🚨  PARADA DE EMERGENCIA  🚨 ' + '\x1b[0m');
  console.error(`🚨 Bloqueo detectado${sourceId ? ` en "${sourceId}"` : ''}: ${reason}`);
  console.error(`🚨 Deteniendo ${active.length} perfil(es) activo(s) para evitar riesgos.`);
  console.error('');

  io.emit('emergency-stop', { reason, sourceId, at: Date.now() });
  notify(`🚨 PARADA DE EMERGENCIA${sourceId ? ` en "${sourceId}"` : ''}: ${reason}. ${active.length} perfil(es) detenido(s).`);

  for (const controller of active) {
    controller.log(`🚨 PARADA DE EMERGENCIA: ${reason} Deteniendo todos los perfiles.`);
  }

  for (const controller of active) {
    await controller.stop().catch(() => {});
  }

  emergencyActive = false;
}

async function checkForBlock(page, controller) {
  if (await detectBlock(page)) {
    await emergencyStop('La página muestra señales de suspensión/bloqueo.', controller.id);
    return true;
  }
  return false;
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

async function clickBumpButton(page) {
  const rawClicked = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('a, button'));
    const el = document.getElementById('managePublishAd')
      || controls.find(e => /bump\s*to\s*top/i.test(`${e.innerText || ''} ${e.id || ''}`.trim()) && e.offsetParent !== null);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }).catch(() => false);
  if (rawClicked) return true;

  const selectors = [
    'a.manage-button:has-text("Bump")',
    'a:has-text("Bump")',
    'button:has-text("Bump to Top")',
    'button:has-text("Bump")',
    'button:has-text("Boost")',
    'a:has-text("Boost")'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 2000 });
      await page.locator(selector).click({ timeout: 4000 });
      return true;
    } catch (_) {
      // seguir probando
    }
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
    controller.setCycleStage('error', 'No se confirmó success_publish.');
    controller.log('⚠️ El botón respondió, pero no se confirmó la publicación en 15 segundos.');
    return false;
  }

  controller.log(`🚀 Bump confirmado (${page.url()}).`);
  controller.setCycleStage('completed', 'Bump confirmado.');
  controller.recordBump();

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
  if (await doBump(page, controller)) return;

  controller.log('Buscando el anuncio en Mis Anuncios...');
  try {
    await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (error) {
    controller.log(`No se pudo abrir Mis Anuncios: ${error.message}`);
    controller.log('No se encontró botón de bump/publicación.');
    return;
  }

  if (await checkForBlock(page, controller)) return;

  if (await doBump(page, controller)) return;

  controller.log('No se encontró botón de bump/publicación.');
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
      await field.type(String(value));
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
    const clicked = await page.waitForFunction((wanted) => {
      const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = normalize(wanted);
      const exactLabel = Array.from(document.querySelectorAll('label[for]')).find((label) =>
        normalize(label.textContent) === target && label.offsetParent !== null
      );
      if (exactLabel) {
        exactLabel.click();
        return true;
      }
      const elements = Array.from(document.querySelectorAll('button, a, [role="button"], li, div, span'))
        .filter((element) => element.offsetParent !== null)
        .filter((element) => normalize(element.textContent) === target || normalize(element.textContent).startsWith(`${target} `));
      const element = elements.sort((a, b) => a.textContent.length - b.textContent.length)[0];
      if (!element) return false;
      element.click();
      return true;
    }, { timeout: 6000 }, choice).catch(() => false);
    if (!clicked) controller.log(`❌ No se encontró la opción ${label}: ${choice}.`);
    return clicked;
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

async function waitForManualCaptcha(page, controller) {
  const captcha = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    const field = fields.find((item) => /captcha|code from|verification/i.test(`${item.name || ''} ${item.id || ''} ${item.placeholder || ''}`));
    const recaptcha = document.querySelector('textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response');
    return { imageField: Boolean(field), recaptcha: Boolean(recaptcha) };
  });

  if (!captcha.imageField && !captcha.recaptcha) return true;

  if (captcha.recaptcha) {
    controller.setCycleStage('captcha', 'Resolviendo CAPTCHA con 2Captcha.');
    controller.log('🧩 CAPTCHA reCAPTCHA detectado. Intentando resolver automáticamente con 2Captcha...');
    await handleCaptchaIfPresent(page, controller);
    const tokenReady = await page.waitForFunction(() => {
      const recaptcha = document.querySelector('textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response');
      return Boolean(recaptcha && recaptcha.value.trim());
    }, { timeout: 10000 }).then(() => true).catch(() => false);
    if (tokenReady) {
      controller.setCycleStage('captcha', 'CAPTCHA resuelto automáticamente.');
      controller.log('✅ CAPTCHA resuelto e inyectado automáticamente.');
      return true;
    }
  }

  controller.setCycleStage('captcha', 'Esperando CAPTCHA manual.');
  controller.log('🧩 CAPTCHA detectado. Introduce el código manualmente en Chrome; el proceso esperará hasta 5 minutos.');
  const solved = await page.waitForFunction(() => {
    const fields = Array.from(document.querySelectorAll('input, textarea'));
    const imageField = fields.find((item) => /captcha|code from|verification/i.test(`${item.name || ''} ${item.id || ''} ${item.placeholder || ''}`));
    const recaptcha = document.querySelector('textarea[name="g-recaptcha-response"], textarea#g-recaptcha-response');
    return Boolean((imageField && imageField.value.trim()) || (recaptcha && recaptcha.value.trim()));
  }, { timeout: 300000 }).then(() => true).catch(() => false);

  if (!solved) {
    controller.setCycleStage('error', 'Tiempo agotado esperando CAPTCHA.');
    controller.log('❌ Tiempo agotado esperando el CAPTCHA manual.');
  }
  return solved;
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

    await fillExactField(page, '#name', details.name) || await fillFieldByLabel(page, '^\\s*name', details.name);
    await fillFieldByLabel(page, '^\\s*headline', details.headline);
    await fillExactField(page, '#age', details.age) || await fillFieldByLabel(page, '^\\s*age', details.age);
    await fillFieldByLabel(page, '^\\s*body', details.text);
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
      const photoInput = photoInputs.find((input) => input) || null;
      if (!photoInput) {
        controller.setCycleStage('error', 'No se encontró el campo de fotos.');
        controller.log('❌ No se encontró el campo de fotos en el formulario.');
        return false;
      }
      if (photoInput && fs.existsSync(photosDir)) {
        const photos = fs.readdirSync(photosDir)
          .filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name))
          .map(name => path.join(photosDir, name));
        if (photos.length > 0) {
          const acceptsMultiple = await photoInput.evaluate((input) => input.multiple);
          if (acceptsMultiple) {
            await photoInput.uploadFile(...photos);
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
    const published = await clickTextControl(page, ['publish', 'post\\s+ad', 'publicar', 'crear anuncio'], 10000);
    if (!published) {
      controller.log('No se encontró el botón final de publicación.');
      return false;
    }

    const confirmed = await page.waitForFunction(
      () => window.location.href.includes('success_publish'),
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
    if (!confirmed) {
      controller.setCycleStage('error', 'No se confirmó success_publish.');
      controller.log('❌ El formulario se envió, pero no apareció la confirmación success_publish.');
      return false;
    }

    controller.log('✅ ¡Anuncio republicado de forma idéntica con éxito!');
    controller.setCycleStage('completed', 'Publicación confirmada.');
    controller.cycleDeleteCompleted = false;
    saveState();
    controller.recordBump();

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

  if (typeof value === 'object') {
    if (!value.host) return null;
    return {
      host: String(value.host).trim(),
      port: Number(value.port) || 0,
      username: String(value.username || ''),
      password: String(value.password || '')
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
    password: (parts[3] || '').trim()
  };
}

function validateCycleConfig(profile) {
  const details = profile.adDetails || {};
  const errors = [];
  const phoneDigits = String(details.phone || '').replace(/\D/g, '');

  if (!String(details.city || '').trim()) errors.push('falta la ciudad');
  if (!String(details.text || '').trim()) errors.push('falta el texto del anuncio');
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

  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  const proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;

  return new ProxyAgent(proxyUrl);
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
    this.stats = { totalBumps: 0, bumpsToday: 0, lastBumpAt: 0, date: todayKey() };
    this.settings = {
      rotateAds: Boolean(cfg.settings?.rotateAds),
      randomizedDelay: Boolean(cfg.settings?.randomizedDelay),
      publishOnStart: Boolean(cfg.settings?.publishOnStart)
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
    saveState();
    this.emitStats();
  }

  async launchProfile() {
    const profileDir = path.join(__dirname, 'profiles', `perfil_${this.id}`);
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.cfg.port}`,
      `--user-data-dir=${profileDir}`,
      '--disable-blink-features=AutomationControlled',
      '--window-size=390,844',
      '--lang=en-US'
    ];

    const proxy = this.cfg.proxy;
    if (proxy && proxy.host) {
      args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
      this.log(`Usando proxy: ${proxy.host}:${proxy.port}`);
    }

    const executablePath = detectChromeExecutable();
    if (executablePath) {
      this.log(`Chrome detectado: ${executablePath}`);
    } else {
      this.log('Chrome del sistema no encontrado; usando el navegador de Puppeteer.');
    }

    const browser = await puppeteer.launch({
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      args
    });

    const page = await browser.newPage();

    if (proxy && proxy.host && proxy.username !== undefined && proxy.password !== undefined) {
      await page.authenticate({ username: proxy.username, password: proxy.password });
      this.log('Auth del proxy configurada.');
    }

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    const client = await page.target().createCDPSession();
    await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Toronto' });
    await client.send('Emulation.setLocaleOverride', { locale: 'en-US' });

    await page.setGeolocation({ latitude: 45.5052, longitude: -73.5557, accuracy: 100 });
    await page.setBypassCSP(true);

    await page.emulate({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      viewport: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      }
    });

    const fp = await page.evaluate(() => ({
      ua: navigator.userAgent,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: navigator.language
    }));
    this.log(`Fingerprint: TZ=${fp.tz} | Lang=${fp.lang}`);

    return { browser, page };
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
      this.log(`Conectando a ${this.cfg.url || DEFAULT_URL}...`);
      await page.goto(this.cfg.url || DEFAULT_URL, {
        waitUntil: 'networkidle2',
        timeout: 90000
      });
      this.log('¡Página cargada con éxito!');

      if (await checkForBlock(page, this)) return false;

      const sessionClosed = await page.evaluate(() => {
        const hasLoginFields = Boolean(document.querySelector('input[type="password"], input[type="email"]'));
        return hasLoginFields && /login|sign in|session expired|sesión/i.test(document.body?.innerText || '');
      }).catch(() => false);
      if (sessionClosed) {
        this.setCycleStage('error', 'Sesión cerrada; inicia sesión manualmente.');
        this.log('❌ La sesión está cerrada. Inicia sesión manualmente antes de continuar.');
        this.emitState('error');
        return false;
      }

      await loginIfNeeded(page, this);
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
      if (this.settings.rotateAds) {
        await deleteAndRepost(this.page, this);
      } else {
        await performBump(this.page, this);
      }
    }

    this.setCycleStage('running', 'Conteo automático activo.');

    this.startCountdown();
    this.scheduleNext();
    this.scheduleRepost();
    this.emitActive();
    this.emitState('running');
    saveState();
  }

  pause() {
    if (!this.started) return;
    this.paused = true;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    if (this._repostTimer) clearTimeout(this._repostTimer);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
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
    this.emitState('running');
  }

  async stop() {
    this.started = false;
    this.paused = false;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    if (this._repostTimer) clearTimeout(this._repostTimer);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    if (this.browser) {
      await this.browser.close().catch(() => {});
    }
    this.browser = null;
    this.page = null;
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

    // Exacto igual que la extensión: obtenerIntervaloAleatorio()
    const minMs = min * 60 * 1000;
    const maxMs = max * 60 * 1000;
    const waitMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

    this._nextBumpAt = Date.now() + waitMs;
    const minutes = Math.round(waitMs / 60000);
    this.log(`Próximo bump en ~${minutes} min (rango ${min}–${max} min).`);
    io.emit('timer', { id: this.id, time: mmss(waitMs) });

    this._cycleTimer = setTimeout(() => this.bumpCycle(), waitMs);
  }

  async bumpCycle() {
    if (this._operationPromise) {
      this.log('Ciclo omitido: ya hay una publicación en curso.');
      return;
    }
    this._operationPromise = this._bumpCycleInternal();
    try {
      await this._operationPromise;
    } finally {
      this._operationPromise = null;
    }
  }

  async _bumpCycleInternal() {
    if (!this.started || this.paused) return;
    this.log('Iniciando ciclo de bump...');

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      this.log('Recarga completada.');
    } catch (error) {
      this.log(`Recarga fallida: ${error.message}`);
    }

    if (await checkForBlock(this.page, this)) return;

    if (this.settings.rotateAds) {
      await deleteAndRepost(this.page, this);
    } else {
      await performBump(this.page, this);
    }
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
    if (this._operationPromise) {
      this.log('Republicación omitida: ya hay una publicación en curso.');
      this.scheduleRepost();
      return;
    }
    this.log('🔄 Iniciando ciclo automático de borrado y republicación...');
    this._operationPromise = deleteAndRepost(this.page, this);
    try {
      await this._operationPromise;
    } finally {
      this._operationPromise = null;
    }
    if (this.started && !this.paused && this.autoRepostActive) this.scheduleRepost();
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
    } finally {
      this._operationPromise = null;
    }
    if (this.started && !this.paused) this.scheduleNext();
    if (!wasStarted && this.started) saveState();
  }

  async _publishNowInternal() {

    this.log('📢 Publicación manual solicitada...');

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      this.log('Recarga completada.');
    } catch (error) {
      this.log(`Recarga fallida: ${error.message}`);
    }

    if (await checkForBlock(this.page, this)) return;

    if (this.settings.rotateAds) {
      await deleteAndRepost(this.page, this);
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

app.get('/api/profiles', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/profiles', (req, res) => {
  try {
    const { id, port, intervalMinutes, bumpMinMinutes, bumpMaxMinutes, url, email, password, proxy, adDetails } = req.body || {};
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
      intervalMinutes: minVal,
      bumpMinMinutes: minVal,
      bumpMaxMinutes: maxVal,
      url: String(url || DEFAULT_URL).trim() || DEFAULT_URL,
      adDetails: {
        name: String(adDetails?.name || '').trim(),
        headline: String(adDetails?.headline || '').trim(),
        city: String(adDetails?.city || '').trim(),
        age: String(adDetails?.age || '').trim(),
        location: String(adDetails?.location || '').trim(),
        phone: String(adDetails?.phone || '').trim(),
        text: String(adDetails?.text || ''),
        photosPath: String(adDetails?.photosPath || '').trim()
      }
    };

    if (proxy && proxy.host) {
      newProfile.proxy = {
        host: String(proxy.host).trim(),
        port: Number(proxy.port),
        username: String(proxy.username || ''),
        password: String(proxy.password || '')
      };
    }

    config.push(newProfile);
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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

    if ('email' in body) {
      profile.email = String(body.email || '').trim();
    }

    if ('password' in body) {
      profile.password = String(body.password || '');
    }

    if (body.adDetails && typeof body.adDetails === 'object') {
      profile.adDetails = {
        name: String(body.adDetails.name || '').trim(),
        headline: String(body.adDetails.headline || '').trim(),
        city: String(body.adDetails.city || '').trim(),
        age: String(body.adDetails.age || '').trim(),
        location: String(body.adDetails.location || '').trim(),
        phone: String(body.adDetails.phone || '').trim(),
        text: String(body.adDetails.text || ''),
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

    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const controller = controllers.get(profile.id);
    if (controller) {
      controller.cfg = profile;
      if (profile.settings) controller.settings = profile.settings;
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
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    io.emit('profiles-updated', config);
    saveState();
    res.json({ success: true });
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

    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

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

  socket.on('open-all', () => {
    for (const c of controllers.values()) c.open();
  });

  socket.on('open-profile', (id) => {
    const controller = controllers.get(id);
    if (controller) controller.open();
  });

  socket.on('start-all', () => {
    for (const c of controllers.values()) c.start();
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
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
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
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }
    Object.assign(controller.cfg, { repostIntervalMin: val, repostInterval: Math.round(val / 60) || 1 });
    if (controller.autoRepostActive && controller.started && !controller.paused) controller.scheduleRepost();
    controller.log(`⏱️ Ciclo de borrado/republicación: ${val} min.`);
  });

});

server.listen(PORT, () => {
  pruneLogs();
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📋 Perfiles cargados: ${controllers.size}`);
  serverLog(`Servidor iniciado en puerto ${PORT} con ${controllers.size} perfil(es).`);
  if (!process.env.PANEL_PASSWORD) {
    console.warn('⚠️ Contraseña del panel por defecto: "momonga". Define PANEL_PASSWORD para cambiarla.');
  }
  restoreActiveProfiles();
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