const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe'
].filter(Boolean);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('Falta config.json. Crea el archivo con tus perfiles antes de lanzar el script.');
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  if (!Array.isArray(config) || config.length === 0) {
    throw new Error('config.json debe contener un array de perfiles.');
  }

  return config;
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

function detectChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    if (!candidate) continue;

    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {
      // ignorar rutas inválidas
    }
  }

  return null;
}

async function launchProfile(profile) {
  const profileDir = path.join(__dirname, 'profiles', `perfil_${profile.id}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${profile.port}`,
    `--user-data-dir=${profileDir}`,
    '--disable-blink-features=AutomationControlled',
    '--window-size=390,844',
    // Forzar idioma en los flags de Chromium
    '--lang=en-US'
  ];

  if (profile.proxy && profile.proxy.host) {
    const proxyUrl = `http://${profile.proxy.host}:${profile.proxy.port}`;
    args.push(`--proxy-server=${proxyUrl}`);
    console.log(`🛡 [${profile.id}] Usando Proxy: ${profile.proxy.host}:${profile.proxy.port}`);
  }

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args
  });

  const page = await browser.newPage();

  if (profile.proxy && profile.proxy.host && profile.proxy.username !== undefined && profile.proxy.password !== undefined) {
    await page.authenticate({ username: profile.proxy.username, password: profile.proxy.password });
    console.log(`🔑 [${profile.id}] Auth del proxy configurada.`);
  }

  // 1. Forzar idioma y cabeceras HTTP en inglés de Canadá/US
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9'
  });

  // 2. Forzar zona horaria y locale vía CDP (la vía fiable en Chrome estable)
  const client = await page.target().createCDPSession();
  await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Toronto' });
  await client.send('Emulation.setLocaleOverride', { locale: 'en-US' });

  // 3. Forzar geolocalización exacta de Montreal, Canadá
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

  // Verificar overrides dentro del contexto de la página
  const fingerprint = await page.evaluate(() => ({
    ua: navigator.userAgent,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: navigator.language,
    langs: [...navigator.languages]
  }));
  console.log(`🔍 [${profile.id}] Fingerprint: UA=${fingerprint.ua} | TZ=${fingerprint.tz} | Lang=${fingerprint.lang} | Langs=${fingerprint.langs.join(',')}`);

  return { browser, page };
}

async function loginIfNeeded(page, profile) {
  if (!profile.email || !profile.password) {
    console.log(`ℹ️ ${profile.id}: sin credenciales, se asume sesión ya abierta.`);
    return;
  }

  const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[type="text"]'];
  const passSelectors = ['input[type="password"]', 'input[name="password"]'];

  const emailSelector = await waitForAnySelector(page, emailSelectors, 10000);
  const passSelector = await waitForAnySelector(page, passSelectors, 10000);

  if (!emailSelector || !passSelector) {
    console.log(`⚠️ ${profile.id}: no se detectaron campos de login.`);
    return;
  }

  await page.locator(emailSelector).fill(profile.email);
  await page.locator(passSelector).fill(profile.password);
  await page.keyboard.press('Enter');
  console.log(`✅ ${profile.id}: login enviado.`);
}

async function performBump(page) {
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
      console.log('🚀 Bump ejecutado.');
      return;
    } catch (_) {
      // seguir probando
    }
  }

  console.log('⚠️ No se encontró botón de bump/publicación.');
}

async function runProfile(profile) {
  const { browser, page } = await launchProfile(profile);

  try {
    console.log(`🌐 [${profile.id}] Conectando a ${profile.url} a través del proxy...`);
    await page.goto(profile.url || 'https://megapersonals.eu/', {
      waitUntil: 'networkidle2',
      timeout: 90000
    });
    console.log(`✅ [${profile.id}] ¡Página cargada con éxito!`);

    await loginIfNeeded(page, profile);
    console.log(`✅ ${profile.id}: perfil abierto en puerto ${profile.port}`);

    while (true) {
      const waitMs = (profile.intervalMinutes || 16) * 60 * 1000;
      console.log(`⏳ ${profile.id}: esperando ${profile.intervalMinutes || 16} minutos ...`);
      await sleep(waitMs);

      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (error) {
        console.log(`⚠️ ${profile.id}: recarga fallida: ${error.message}`);
      }

      await performBump(page);
      console.log(`🔁 ${profile.id}: ciclo completado.`);
    }
  } catch (error) {
    console.error(`❌ Error crítico en ${profile.id}:`, error);
    await browser.close();
  }
}

(async () => {
  try {
    const config = loadConfig();
    console.log('🚀 Iniciando automatización multi-perfil...');

    for (const profile of config) {
      runProfile(profile).catch((error) => {
        console.error(`❌ ${profile.id}: fallo no manejado:`, error);
      });
    }

    setInterval(() => {}, 1000);
  } catch (error) {
    console.error('❌ Error general:', error.message);
    process.exit(1);
  }
})();
