// Suite de pruebas de MOMONGA PRO.
// Uso: npm test
// Levanta el sitio simulado (mock-site.js) + un 2Captcha falso y prueba los flujos clave.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, '.tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}

function adDetails(extra) {
  return Object.assign({
    name: 'N', headline: 'H', city: 'Montreal', age: '25', location: 'L',
    phone: '5555555555', text: 'Texto de prueba', photosPath: ''
  }, extra || {});
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true; } catch (_) {}
    await sleep(300);
  }
  return false;
}

let scenarioIndex = 0;

async function withStack(opts, fn) {
  fs.mkdirSync(TMP, { recursive: true });
  scenarioIndex += 1;
  const dir = fs.mkdtempSync(path.join(TMP, 'run-'));
  const authPath = path.join(dir, 'panel-auth.json');
  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'state.json');
  const keyPath = path.join(dir, 'secrets.key');
  const panelPort = 4050 + scenarioIndex;
  const profilePort = 9400 + scenarioIndex * 10;
  const mockPort = 4200 + scenarioIndex;
  const fakePort = 4310 + scenarioIndex;
  const useFake2Captcha = Boolean(opts.captcha);

  const profiles = (opts.profiles || []).map((p, i) => Object.assign({
    id: `${p.id}`, port: profilePort + i, email: '', password: '', intervalMinutes: 30, bumpMinMinutes: 30, bumpMaxMinutes: 30,
    url: `http://127.0.0.1:${mockPort}/`,
    adDetails: adDetails(), settings: { rotateAds: false, randomizedDelay: false, publishOnStart: false },
    autoRepostActive: false
  }, p));
  fs.writeFileSync(configPath, JSON.stringify(profiles, null, 2));

  const mock = spawn('node', ['mock-site.js'], { cwd: ROOT, env: { ...process.env, MOCK_SCENARIO: opts.scenario || 'normal', MOCK_ADS: String(opts.ads || 1), MOCK_PORT: String(mockPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const fake = useFake2Captcha
    ? spawn('node', [path.join(__dirname, 'fake-2captcha.js')], { env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_CODE: 'Z8VQ' }, stdio: ['ignore', 'pipe', 'pipe'] })
    : null;
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(panelPort), PANEL_PASSWORD: 'testpass', PANEL_AUTH_PATH: authPath,
      CONFIG_PATH: configPath, STATE_PATH: statePath, SECRETS_KEY_PATH: keyPath, MOMONGA_NO_OPEN: '1',
      ...(opts.env || {}),
      ...(useFake2Captcha ? { TWOCAPTCHA_BASE: `http://127.0.0.1:${fakePort}` } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', (d) => { out += d.toString(); });
  server.stderr.on('data', (d) => { out += d.toString(); });

  const base = `http://127.0.0.1:${panelPort}`;
  let browser;
  try {
    await waitFor(`http://127.0.0.1:${mockPort}/`);
    await waitFor(`${base}/login`);
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`${base}/login`);
    await page.type('input[name="password"]', 'testpass');
    await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
    await page.waitForSelector('[data-action="start"]', { timeout: 20000 });
    await fn({ page, out: () => out, base, configPath, dir, mockPort });
  } finally {
    if (browser) await browser.close().catch(() => {});
    mock.kill();
    if (fake) fake.kill();
    server.kill();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function startAll(page) { await page.click('#startAllBtn'); }
async function startFirst(page) { await page.click('[data-action="start"]'); }

async function waitForLog(getOut, re, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(getOut())) return true;
    await sleep(1500);
  }
  return false;
}

async function runTests() {
  console.log('=== MOMONGA PRO - suite de pruebas ===\n');

  // 1) Publicación completa (borrar + republicar)
  await withStack({
    scenario: 'normal',
    profiles: [{ id: 'perfil-repost', settings: { rotateAds: false, randomizedDelay: false, publishOnStart: false }, autoRepostActive: true, repostIntervalMin: 1 }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /republicado de forma idéntica/i);
    record('repost: republica con éxito', ok, ok ? 'ok' : 'no confirmó');
    const okModal = await waitForLog(out, /Modal de confirmación cerrado/i, 20000);
    record('repost: cierra modal Success! con OK', okModal, 'ok');
  });

  // 2) Captcha de imagen: resuelve, escribe y publica
  await withStack({
    scenario: 'captcha-pending', captcha: true,
    profiles: [{ id: 'perfil-cap', apiKey2Captcha: 'test_key_123456789012345678901234', autoRepostActive: true, repostIntervalMin: 1 }]
  }, async ({ page, out, mockPort }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /republicado de forma idéntica/i);
    const state = await (await fetch(`http://127.0.0.1:${mockPort}/captcha-value`)).json();
    record('captcha: 2Captcha resuelve', /resuelto e introducido: "Z8VQ"/i.test(out()), 'ok');
    record('captcha: escribe el código en el campo', state.captcha === 'Z8VQ', `"${state.captcha}"`);
    record('captcha: publica tras escribir', ok, ok ? 'ok' : 'no');
  });

  // 3) Rotación de anuncios (bump uno por uno)
  await withStack({
    scenario: 'multi-ads', ads: 3,
    profiles: [{ id: 'perfil-rot', settings: { rotateAds: true, randomizedDelay: false, publishOnStart: false } }]
  }, async ({ page, mockPort }) => {
    await startFirst(page);
    await sleep(3000);
    const getIds = async () => {
      const html = await (await fetch(`http://127.0.0.1:${mockPort}/users/posts/list`)).text();
      const m = html.match(/IDs:\s*<strong>([^<]*)<\/strong>/);
      return (m && m[1] ? m[1].split(',').filter(Boolean) : []);
    };
    for (let k = 0; k < 3; k++) {
      const before = (await getIds()).length;
      await page.click('[data-action="publish"]');
      let count = before;
      for (let j = 0; j < 60 && count <= before; j++) { await sleep(1500); count = (await getIds()).length; }
      await sleep(3000);
    }
    const ids = await getIds();
    record('rotacion: 3 bumps sin repetir', ids.length >= 3 && new Set(ids.slice(0, 3)).size === 3, ids.slice(0, 3).join(' > '));
  });

  // 4) Detección de bloqueo por /users/ban_message
  await withStack({
    scenario: 'ban-url',
    profiles: [{ id: 'perfil-ban', email: 'cuenta@ejemplo.com', settings: { rotateAds: true, randomizedDelay: false, publishOnStart: false } }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /PARADA DE EMERGENCIA/i, 60000);
    record('bloqueo: detecta ban_message y para todo', ok, ok ? 'ok' : 'no');
  });

  // 4b) Detección de bloqueo por la página "scam-page" (fraud bots / phished)
  await withStack({
    scenario: 'scam-page',
    profiles: [{ id: 'perfil-scam', email: 'cuenta@ejemplo.com', settings: { rotateAds: true, randomizedDelay: false, publishOnStart: false } }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /PARADA DE EMERGENCIA/i, 60000);
    record('bloqueo: detecta la scam-page (fraud bots) y para todo', ok, ok ? 'ok' : 'no');
  });

  // 5) Publicar con el botón div#input_send
  await withStack({
    scenario: 'input-send',
    profiles: [{ id: 'perfil-send', autoRepostActive: true, repostIntervalMin: 1 }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /republicado de forma idéntica/i);
    record('publicar: usa el botón div#input_send', ok && !/No se encontró el botón final/i.test(out()), ok ? 'ok' : 'no');
  });

  // 6) Popup de tokens (ciudad de pago)
  await withStack({
    scenario: 'token-popup',
    profiles: [{ id: 'perfil-tok', autoRepostActive: true, repostIntervalMin: 1 }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /republicado de forma idéntica/i);
    record('tokens: confirma el popup y publica', ok && /Popup de tokens detectado/i.test(out()), ok ? 'ok' : 'no');
  });

  // 7) Página de imágenes pendientes + modal Success
  await withStack({
    scenario: 'pending-images',
    profiles: [{ id: 'perfil-pi', autoRepostActive: true, repostIntervalMin: 1 }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /republicado de forma idéntica/i);
    record('pendingImages: pulsa OK y publica', ok && /imágenes pendientes; pulsando OK/i.test(out()), ok ? 'ok' : 'no');
  });

  // 8) Tope diario y que el intervalo respete lo configurado
  await withStack({
    scenario: 'normal',
    profiles: [{ id: 'perfil-lim', intervalMinutes: 1, bumpMinMinutes: 1, bumpMaxMinutes: 1, settings: { rotateAds: false, randomizedDelay: false, publishOnStart: true }, limits: { dailyLimit: 1 } }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /Tope diario alcanzado/i, 180000);
    record('limites: tope diario bloquea', ok, ok ? 'ok' : 'no');
    const excedido = /Próximo bump en ~([2-9]|\d{2,}) min/.test(out());
    record('limites: el intervalo no sube solo (respeta 1 min)', !excedido, excedido ? 'se infló' : 'ok');
  });

  // 9) Detección de bloqueo por HTTP 403
  await withStack({
    scenario: 'http-403',
    profiles: [{ id: 'perfil-403', email: 'cuenta@ejemplo.com', settings: { rotateAds: true, randomizedDelay: false, publishOnStart: false } }]
  }, async ({ page, out }) => {
    await startFirst(page);
    const ok = await waitForLog(out, /PARADA DE EMERGENCIA/i, 60000);
    record('bloqueo: detecta HTTP 403 y para todo', ok && /HTTP 403/i.test(out()), ok ? 'ok' : 'no');
  });

  // 10) Arranque escalonado (no abrir todas a la vez)
  await withStack({
    scenario: 'normal', env: { START_STAGGER_SECONDS: '1' },
    profiles: [{ id: 'perfil-st1' }, { id: 'perfil-st2' }, { id: 'perfil-st3' }]
  }, async ({ page, out }) => {
    await startAll(page);
    await sleep(2500);
    const early = (out().match(/Navegador abierto/g) || []).length;
    for (let i = 0; i < 40 && (out().match(/Navegador abierto/g) || []).length < 3; i++) await sleep(1500);
    const total = (out().match(/Navegador abierto/g) || []).length;
    record('arranque escalonado: no abre todas a la vez', early <= 1 && total >= 3, `a 2.5s=${early}, total=${total}`);
  });

  // 11) Apelación manual desde el panel
  await withStack({
    scenario: 'normal',
    profiles: [{ id: 'perfil-appeal', email: 'cuenta@ejemplo.com' }]
  }, async ({ page, out }) => {
    await startFirst(page);
    await sleep(3000);
    await page.click('[data-action="appeal"]');
    const ok = await waitForLog(out, /Apelación manual creada/i, 20000);
    record('apelacion: boton Apelar crea el borrador', ok, ok ? 'ok' : 'no');
  });

  // Limpiar apelaciones creadas por las pruebas (perfiles "perfil-*")
  try {
    const indexPath = path.join(ROOT, 'logs', 'appeals', 'index.json');
    if (fs.existsSync(indexPath)) {
      const arr = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const kept = (Array.isArray(arr) ? arr : []).filter((r) => !/^perfil-/.test(r.profile || ''));
      fs.writeFileSync(indexPath, `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
    }
  } catch (_) {}

  // Resumen
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} pruebas OK ===`);
  if (failed.length) {
    console.log('Fallaron:');
    for (const f of failed) console.log(` - ${f.name} (${f.detail})`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

runTests().catch((error) => {
  console.error('Error en la suite:', error);
  process.exit(1);
});
