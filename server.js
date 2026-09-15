const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PORT = process.env.PORT || 3000;
const DEFAULT_URL = 'https://megapersonals.eu/';

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

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
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
  if (!siteKey) return false;

  const apiKey = controller.cfg.apiKey2Captcha;
  if (!apiKey || /^AQUÍ/i.test(apiKey)) {
    controller.log('CAPTCHA detectado pero falta apiKey2Captcha en config.json.');
    return false;
  }

  controller.log('🧩 CAPTCHA detectado. Resolviendo con 2Captcha...');
  const solved = await solveCaptcha(apiKey, siteKey, page.url(), page);
  controller.log(solved ? '✅ CAPTCHA resuelto e inyectado.' : '❌ No se pudo resolver el CAPTCHA.');
  return solved;
}

async function loginIfNeeded(page, controller) {
  if (!controller.cfg.email || !controller.cfg.password) {
    controller.log('Sin credenciales, se asume sesión ya abierta.');
    return;
  }

  const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[type="text"]'];
  const passSelectors = ['input[type="password"]', 'input[name="password"]'];

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
}

async function performBump(page, controller) {
  const selectors = [
    'button:has-text("Bump")',
    'button:has-text("Boost")',
    'button:has-text("Publish")',
    'button:has-text("Update")',
    'button:has-text("Post")',
    'a:has-text("Bump")',
    'a:has-text("Boost")',
    'a:has-text("Publish")'
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 1500 });
      await page.locator(selector).click({ timeout: 8000 });
      controller.log('🚀 Bump ejecutado.');
      return;
    } catch (_) {
      // seguir probando
    }
  }

  controller.log('No se encontró botón de bump/publicación.');
}

async function publishOnLatestPage(browser, controller) {
  const pages = await browser.pages();
  const page = pages[pages.length - 1];
  if (!page) {
    controller.log('No hay ninguna pestaña activa para publicar.');
    return false;
  }

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    const target = buttons.find(button => {
      const text = `${button.innerText || ''} ${button.value || ''}`;
      return /bump|boost|publish|post|update/i.test(text);
    });

    if (!target) return false;
    target.click();
    return true;
  });

  if (clicked) {
    controller.log('Publicación ejecutada con éxito.');
  } else {
    controller.log('No se encontró el botón de publicación en la página actual.');
  }

  return clicked;
}

async function clickTextControl(page, patterns, timeout = 10000) {
  const found = await page.waitForFunction((expectedPatterns) => {
    const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    return controls.some(control => {
      const text = `${control.innerText || ''} ${control.value || ''}`.trim();
      return expectedPatterns.some(pattern => new RegExp(pattern, 'i').test(text));
    });
  }, { timeout }, patterns);

  if (!found) return false;
  await page.evaluate((expectedPatterns) => {
    const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    const target = controls.find(control => {
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

async function deleteAndRepost(page, controller) {
  const details = controller.cfg.adDetails || {};
  if (!details.city || !details.text) {
    controller.log('Delete and Repost omitido: faltan ciudad o texto en adDetails.');
    return false;
  }

  try {
    controller.log('🗑️ Iniciando ciclo de borrado del anuncio actual...');
    await page.goto('https://megapersonals.eu/users/posts', { waitUntil: 'networkidle2', timeout: 60000 });

    await page.evaluate(() => {
      const deleteBtn = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
        .find(el => /delete|borrar|eliminar/i.test(`${el.innerText || ''} ${el.value || ''}`));
      if (deleteBtn) deleteBtn.click();
    });

    await sleep(3000);

    await page.waitForFunction(() => {
      const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
      return controls.some(control => /confirm|yes|sí|si|delete|borrar/i.test(`${control.innerText || ''} ${control.value || ''}`));
    }, { timeout: 5000 }).then(() => clickTextControl(page, ['confirm', '^yes$', '^sí$', '^si$', 'delete', 'borrar'], 3000)).catch(() => {});

    controller.log('📢 Publicando nuevo anuncio idéntico...');
    await page.goto('https://megapersonals.eu/users/post/new', { waitUntil: 'networkidle2', timeout: 60000 });

    await fillFirst(page, [
      'input[name="city"]', 'select[name="city"]', 'input[name*="city" i]', 'select[name*="city" i]'
    ], details.city);

    if (details.age) {
      await fillFirst(page, [
        'input[name="age"]', 'select[name="age"]', 'input[name*="age" i]', 'select[name*="age" i]'
      ], details.age);
    }

    await fillFirst(page, [
      'textarea[name="body"]', 'textarea[name*="text" i]', 'textarea[name*="description" i]', 'textarea'
    ], details.text);

    if (details.photosPath) {
      const photosDir = path.resolve(__dirname, details.photosPath);
      const photoInput = await page.$('input[type="file"]');
      if (photoInput && fs.existsSync(photosDir)) {
        const photos = fs.readdirSync(photosDir)
          .filter(name => /\.(jpg|jpeg|png|webp)$/i.test(name))
          .map(name => path.join(photosDir, name));
        if (photos.length > 0) {
          await photoInput.uploadFile(...photos);
        } else {
          controller.log('Aviso: no hay fotos en la carpeta configurada.');
        }
      }
    }

    const published = await clickTextControl(page, ['publish', 'post\\s+ad', 'publicar', 'crear anuncio'], 10000);
    if (!published) {
      controller.log('No se encontró el botón final de publicación.');
      return false;
    }

    controller.log('✅ ¡Anuncio republicado de forma idéntica con éxito!');
    return true;
  } catch (error) {
    controller.log(`❌ Error en el ciclo de republicación: ${error.message}`);
    return false;
  }
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

async function scrapeActiveAdData(page) {
  return page.evaluate(() => {
    const readValue = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && 'value' in el && el.value) return el.value;
      }
      return '';
    };

    return {
      city: readValue(['input[name="city"]', 'select[name="city"]', 'input[name*="city" i]', 'select[name*="city" i]']),
      age: readValue(['input[name="age"]', 'select[name="age"]', 'input[name*="age" i]']),
      text: readValue(['textarea[name="body"]', 'textarea[name*="text" i]', 'textarea[name*="description" i]', 'textarea'])
    };
  });
}

async function scrapeActiveAdPhotos(page) {
  return page.evaluate(() => {
    const urls = [];
    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src || !/^https?:/i.test(src)) return;
      if (img.naturalWidth >= 300 && img.naturalHeight >= 300) {
        urls.push(src);
      }
    });
    return [...new Set(urls)];
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
    this._nextRepostAt = 0;
    this.autoRepostActive = Boolean(cfg.autoRepostActive);
    this.repostInterval = Number(cfg.repostInterval) || 6;
    this.settings = {
      rotateAds: Boolean(cfg.settings?.rotateAds),
      randomizedDelay: Boolean(cfg.settings?.randomizedDelay),
      publishOnStart: Boolean(cfg.settings?.publishOnStart)
    };
  }

  log(text) {
    console.log(`[${this.id}]`, text);
    io.emit('log', { id: this.id, text });
  }

  emitActive() {
    let active = 0;
    for (const c of controllers.values()) {
      if (c.started && c.browser) active++;
    }
    io.emit('active-count', { active });
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

    const browser = await puppeteer.launch({
      headless: false,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

  async start() {
    if (this.started) {
      if (this.paused) {
        this.resume();
      } else {
        this.log('Ya está en ejecución.');
      }
      return;
    }

    this.started = true;
    this.paused = false;

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

      await loginIfNeeded(page, this);
      this.log('Perfil listo.');

      if (this.settings.publishOnStart) {
        this.log('Publicación al iniciar activada.');
        await performBump(page, this);
      }

      this.startCountdown();
      this.scheduleNext();
      this.scheduleRepost();
      this.emitActive();
    } catch (error) {
      this.log(`Error crítico: ${error.message}`);
      await this.stop();
    }
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
  }

  resume() {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.log('▶ Reanudado.');
    this.startCountdown();
    this.scheduleNext();
    this.scheduleRepost();
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
    this.log('🛑 Detenido.');
    this.emitActive();
  }

  startCountdown() {
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    this._countdownTimer = setInterval(() => {
      if (!this.started || this.paused) return;
      const remaining = Math.max(0, this._nextBumpAt - Date.now());
      io.emit('timer', { id: this.id, time: mmss(remaining) });
    }, 1000);
  }

  scheduleNext() {
    if (!this.started || this.paused) return;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);

    const baseMs = (this.cfg.intervalMinutes || 16) * 60 * 1000;
    let waitMs = baseMs;

    if (this.settings.randomizedDelay) {
      const jitter = (Math.random() * 2 - 1) * 0.2 * baseMs;
      waitMs = Math.max(60 * 1000, Math.round(baseMs + jitter));
    }

    this._nextBumpAt = Date.now() + waitMs;
    const minutes = Math.round(waitMs / 60000);
    this.log(`Próximo bump en ~${minutes} min${this.settings.randomizedDelay ? ' (intervalo aleatorio)' : ''}.`);
    io.emit('timer', { id: this.id, time: mmss(waitMs) });

    this._cycleTimer = setTimeout(() => this.bumpCycle(), waitMs);
  }

  async bumpCycle() {
    if (!this.started || this.paused) return;
    this.log('Iniciando ciclo de bump...');

    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      this.log('Recarga completada.');
    } catch (error) {
      this.log(`Recarga fallida: ${error.message}`);
    }

    if (this.settings.rotateAds) {
      await deleteAndRepost(this.page, this);
    } else {
      await performBump(this.page, this);
    }
    this.log('Ciclo completado.');

    this.scheduleNext();
  }

  setAutoRepost(active, interval) {
    this.autoRepostActive = Boolean(active);
    if (interval !== undefined && interval !== null && interval !== '') {
      this.repostInterval = Number(interval) || this.repostInterval;
    }
    if (this._repostTimer) {
      clearTimeout(this._repostTimer);
      this._repostTimer = null;
    }
    if (this.autoRepostActive && this.started && !this.paused) {
      this.scheduleRepost();
    }
  }

  scheduleRepost() {
    if (!this.started || this.paused || !this.autoRepostActive) return;
    if (this._repostTimer) clearTimeout(this._repostTimer);

    const waitMs = this.repostInterval * 60 * 60 * 1000;
    this._nextRepostAt = Date.now() + waitMs;
    this.log(`🔄 Ciclo de borrado/republicación en ${this.repostInterval} h.`);
    this._repostTimer = setTimeout(() => this.repostCycle(), waitMs);
  }

  async repostCycle() {
    if (!this.started || this.paused || !this.autoRepostActive) return;
    this.log('🔄 Iniciando ciclo automático de borrado y republicación...');
    await deleteAndRepost(this.page, this);
    this.scheduleRepost();
  }

  async publishNow() {
    if (!this.started) {
      this.log('Primero inicia el perfil para poder publicar.');
      return;
    }
    this.log('Publicación manual solicitada.');

    try {
      await publishOnLatestPage(this.browser, this);
    } catch (error) {
      this.log(`Error al publicar: ${error.message}`);
    }
  }
}

let controllers = new Map();

function buildControllers() {
  controllers = new Map();
  try {
    const config = loadConfig();
    for (const profile of config) {
      controllers.set(profile.id, new ProfileController(profile));
    }
    return config;
  } catch (error) {
    console.error(error.message);
    return [];
  }
}

buildControllers();

app.get('/api/profiles', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/profiles', (req, res) => {
  try {
    const { id, port, intervalMinutes, url, email, password, proxy, adDetails } = req.body || {};
    const cleanId = String(id || '').trim();
    const numericPort = Number(port);
    const numericInterval = Number(intervalMinutes);

    if (!cleanId || !Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) {
      return res.status(400).json({ error: 'El nombre y el puerto válido son obligatorios.' });
    }
    if (!Number.isFinite(numericInterval) || numericInterval < 1) {
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
      intervalMinutes: numericInterval,
      url: String(url || DEFAULT_URL).trim() || DEFAULT_URL,
      adDetails: {
        city: String(adDetails?.city || '').trim(),
        age: String(adDetails?.age || '').trim(),
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
        city: String(body.adDetails.city || '').trim(),
        age: String(body.adDetails.age || '').trim(),
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
    await controller.page.goto('https://megapersonals.eu/users/posts', { waitUntil: 'networkidle2', timeout: 60000 });
    const data = await scrapeActiveAdData(controller.page);
    controller.log('📥 Datos del anuncio copiados desde el navegador.');

    const photoUrls = await scrapeActiveAdPhotos(controller.page);
    let photosPath = '';
    let photosSaved = 0;

    if (photoUrls.length > 0) {
      const targetDir = path.join(__dirname, 'profiles', controller.id, 'photos');
      const dispatcher = buildProxyDispatcher(controller.cfg.proxy);
      controller.log(`🖼️ Descargando y limpiando ${photoUrls.length} foto(s)${dispatcher ? ' vía proxy' : ''}...`);
      try {
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
      const hours = Number(body.repostInterval);
      if (!Number.isFinite(hours) || hours < 1 || hours > 72) {
        return res.status(400).json({ success: false, error: 'El intervalo debe estar entre 1 y 72 horas.' });
      }
      profile.repostInterval = hours;
    }

    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    const controller = controllers.get(profile.id);
    if (controller) {
      controller.cfg = profile;
      controller.setAutoRepost(profile.autoRepostActive, profile.repostInterval);
    }
    res.json({ success: true, autoRepostActive: Boolean(profile.autoRepostActive), repostInterval: Number(profile.repostInterval) || 6 });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('🔌 Interfaz conectada.');

  for (const c of controllers.values()) {
    io.emit('timer', { id: c.id, time: mmss((c.cfg.intervalMinutes || 16) * 60 * 1000) });
  }
  let active = 0;
  for (const c of controllers.values()) {
    if (c.started && c.browser) active++;
  }
  io.emit('active-count', { active });

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
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📋 Perfiles cargados: ${controllers.size}`);
  if (!process.env.PANEL_PASSWORD) {
    console.warn('⚠️ Contraseña del panel por defecto: "momonga". Define PANEL_PASSWORD para cambiarla.');
  }
});

process.on('SIGINT', async () => {
  console.log('\nCerrando navegadores...');
  for (const c of controllers.values()) {
    await c.stop();
  }
  process.exit(0);
});