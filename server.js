const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
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
const MODERN_ANDROID = [
  { key: 'pixel_9', label: 'Google Pixel 9', model: 'Pixel 9', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'pixel_9_pro', label: 'Google Pixel 9 Pro', model: 'Pixel 9 Pro', androidVersion: '16.0.0', dsf: 3 },
  { key: 'pixel_9_pro_xl', label: 'Google Pixel 9 Pro XL', model: 'Pixel 9 Pro XL', androidVersion: '16.0.0', dsf: 3 },
  { key: 'pixel_9_pro_fold', label: 'Google Pixel 9 Pro Fold', model: 'Pixel 9 Pro Fold', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'pixel_10', label: 'Google Pixel 10', model: 'Pixel 10', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'pixel_10_pro', label: 'Google Pixel 10 Pro', model: 'Pixel 10 Pro', androidVersion: '16.0.0', dsf: 3 },
  { key: 's25', label: 'Samsung Galaxy S25', model: 'SM-S931B', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 's25_plus', label: 'Samsung Galaxy S25+', model: 'SM-S936B', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 's25_ultra', label: 'Samsung Galaxy S25 Ultra', model: 'SM-S938B', androidVersion: '16.0.0', dsf: 3 },
  { key: 's24', label: 'Samsung Galaxy S24', model: 'SM-S921B', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 's24_ultra', label: 'Samsung Galaxy S24 Ultra', model: 'SM-S928B', androidVersion: '15.0.0', dsf: 3 },
  { key: 's23_fe', label: 'Samsung Galaxy S23 FE', model: 'SM-S711B', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'zf6', label: 'Samsung Galaxy Z Fold6', model: 'SM-F956B', androidVersion: '15.0.0', dsf: 3 },
  { key: 'zf7', label: 'Samsung Galaxy Z Fold7', model: 'SM-F966B', androidVersion: '16.0.0', dsf: 3 },
  { key: 'zf6_flip', label: 'Samsung Galaxy Z Flip6', model: 'SM-F741B', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'zf7_flip', label: 'Samsung Galaxy Z Flip7', model: 'SM-F761B', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'a56', label: 'Samsung Galaxy A56', model: 'SM-A566B', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'a36', label: 'Samsung Galaxy A36', model: 'SM-A366B', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'oneplus_13', label: 'OnePlus 13', model: 'CPH2665', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'oneplus_13r', label: 'OnePlus 13R', model: 'CPH2663', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'oneplus_12', label: 'OnePlus 12', model: 'CPH2583', androidVersion: '15.0.0', dsf: 3 },
  { key: 'oneplus_nord4', label: 'OnePlus Nord 4', model: 'CPH2653', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'oneplus_open', label: 'OnePlus Open', model: 'CPH2551', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'xiaomi_15', label: 'Xiaomi 15', model: '24129PN7DC', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'xiaomi_15_pro', label: 'Xiaomi 15 Pro', model: '2410DPN6CC', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'xiaomi_14', label: 'Xiaomi 14', model: '23127PN0CC', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'xiaomi_14_ultra', label: 'Xiaomi 14 Ultra', model: '24031PN7DC', androidVersion: '15.0.0', dsf: 3 },
  { key: 'redmi_note14_pro', label: 'Xiaomi Redmi Note 14 Pro', model: '24094RAD4G', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'redmi_note14', label: 'Xiaomi Redmi Note 14', model: '24094RAD4C', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'poco_f7', label: 'POCO F7', model: '2412DPC0AG', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'poco_x7_pro', label: 'POCO X7 Pro', model: '24117PNCCG', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'moto_g85', label: 'Motorola Moto G85', model: 'XT2425-3', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'edge_50', label: 'Motorola Edge 50', model: 'XT2407-4', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'edge_50_pro', label: 'Motorola Edge 50 Pro', model: 'XT2403-2', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'edge_60_ultra', label: 'Motorola Edge 60 Ultra', model: 'XT2603-1', androidVersion: '16.0.0', dsf: 3 },
  { key: 'razr_50_ultra', label: 'Motorola Razr 50 Ultra', model: 'XT2453-4', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'moto_g_2026', label: 'Motorola Moto G (2026)', model: 'XT2625-1', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'honor_magic7_pro', label: 'Honor Magic 7 Pro', model: 'HOS100', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'honor_magic6_pro', label: 'Honor Magic 6 Pro', model: 'BVL-AN00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'honor_200_pro', label: 'Honor 200 Pro', model: 'ELP-AN00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'honor_90_gt', label: 'Honor 90 GT', model: 'ALP-AN00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'magic_v3', label: 'Honor Magic V3', model: 'PTP-AN00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'oppo_find_x8', label: 'OPPO Find X8', model: 'CPH2651', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'oppo_find_x8_pro', label: 'OPPO Find X8 Pro', model: 'CPH2655', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'oppo_find_n5', label: 'OPPO Find N5', model: 'CPH2691', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'oppo_reno13', label: 'OPPO Reno 13', model: 'CPH2685', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'vivo_x200', label: 'vivo X200', model: 'V2415', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'vivo_x200_pro', label: 'vivo X200 Pro', model: 'V2416', androidVersion: '15.0.0', dsf: 3 },
  { key: 'vivo_v30_pro', label: 'vivo V30 Pro', model: 'V2314', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'nothing_3a', label: 'Nothing Phone (3a)', model: 'A063', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'nothing_3a_pro', label: 'Nothing Phone (3a) Pro', model: 'A065', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'nothing_2', label: 'Nothing Phone (2)', model: 'A065', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'xperia_1_vi', label: 'Sony Xperia 1 VI', model: 'XQ-EC72', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'xperia_5_vi', label: 'Sony Xperia 5 VI', model: 'XQ-ES72', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'rog_phone_9', label: 'Asus ROG Phone 9', model: 'ASUS_AI2401', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'rog_phone_9_pro', label: 'Asus ROG Phone 9 Pro', model: 'ASUS_AI2401', androidVersion: '15.0.0', dsf: 3 },
  { key: 'rog_phone_8', label: 'Asus ROG Phone 8', model: 'ASUS_AI2401_C', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'zenfone_12', label: 'Asus Zenfone 12 Ultra', model: 'ASUS_AI2501', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'realme_gt7_pro', label: 'Realme GT7 Pro', model: 'RMX5010', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'realme_gt6', label: 'Realme GT6', model: 'RMX3800', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'realme_14_pro', label: 'Realme 14 Pro+', model: 'RMX5100', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'huawei_pura70_pro', label: 'Huawei Pura 70 Pro', model: 'HBN-AL00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'huawei_mate80', label: 'Huawei Mate 80 Pro', model: 'MUL-AL00', androidVersion: '16.0.0', dsf: 2.625 },
  { key: 'huawei_nova13', label: 'Huawei nova 13 Pro', model: 'BRC-AN00', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'tecno_phantom_vfold2', label: 'Tecno Phantom V Fold 2', model: 'Phantom V Fold 2', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'tecno_phantom_x2', label: 'Tecno Phantom X2 Pro', model: 'Phantom X2 Pro', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'infini_gt20', label: 'Infinix GT 20 Pro', model: 'X6871', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'infini_zero_ultra', label: 'Infinix Zero Ultra', model: 'X6820', androidVersion: '12.0.0', dsf: 2.625 },
  { key: 'zte_axon60_ultra', label: 'ZTE Axon 60 Ultra', model: 'A3050', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'nubia_z70', label: 'Nubia Z70 Ultra', model: 'NX733J', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'iqoo_13', label: 'iQOO 13', model: 'V2453', androidVersion: '15.0.0', dsf: 2.625 },
  { key: 'nokia_x30', label: 'Nokia X30', model: 'Nokia X30 5G', androidVersion: '14.0.0', dsf: 2.625 },
  { key: 'sharp_aquos_r9', label: 'Sharp Aquos R9', model: 'SH-51E', androidVersion: '14.0.0', dsf: 2.625 }
];

function androidUserAgent(model, major, androidVersion) {
  return `Mozilla/5.0 (Linux; Android ${androidVersion.split('.')[0]}; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
}

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

  // Dispositivos modernos elegibles individualmente por perfil (User-Agent + pantalla coherentes).
  const fromList = MODERN_ANDROID.find((d) => d.key === name);
  if (fromList) {
    return {
      userAgent: androidUserAgent(fromList.model, major, fromList.androidVersion),
      viewport: { width: 412, height: 915, deviceScaleFactor: fromList.dsf, isMobile: true, hasTouch: true },
      kind: 'android', platform: 'Android', model: fromList.model,
      androidVersion: fromList.androidVersion
    };
  }

  const preset = presets[name] || presets.iphone;
  return preset;
}

function isValidDevice(name) {
  return ['iphone', 'android', 'pixel', 'pixel_pro', 'samsung', 'samsung_ultra']
    .concat(MODERN_ANDROID.map((d) => d.key))
    .includes(name);
}

// Cabeceras coherentes con el dispositivo (evita que el UA y los Client Hints se contradigan).
function chHeadersFor(device, chromeMajor) {
  const base = { 'Accept-Language': 'en-US,en;q=0.9' };
  const major = String(chromeMajor || '140');
  if (device && device.kind === 'android') {
    return Object.assign(base, {
      'Sec-CH-UA': `"Not?A_Brand";v="24", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
      'Sec-CH-UA-Mobile': '?1',
      'Sec-CH-UA-Platform': '"Android"',
      'Sec-CH-UA-Platform-Version': `"${device.androidVersion || '16.0.0'}"`,
      'Sec-CH-UA-Model': `"${device.model}"`
    });
  }
  // iPhone: Safari no manda Client Hints, pero Chrome si. Al menos que la plataforma concuerde.
  return Object.assign(base, {
    'Sec-CH-UA': `"Chromium";v="${major}", "Not?A_Brand";v="24"`,
    'Sec-CH-UA-Mobile': '?1',
    'Sec-CH-UA-Platform': '"iOS"',
    'Sec-CH-UA-Platform-Version': '"18.0.0"'
  });
}

// Metadatos del navegador (userAgentData) coherentes con el dispositivo. Se aplican
// por CDP (Emulation.setUserAgentOverride), NO por getters JS (que los detectan).
function uaMetadataFor(device, chromeMajor) {
  if (!device || device.kind !== 'android') return undefined;
  const major = String(chromeMajor || '140');
  return {
    brands: [
      { brand: 'Not?A_Brand', version: '24' },
      { brand: 'Chromium', version: major },
      { brand: 'Google Chrome', version: major },
    ],
    fullVersionList: [
      { brand: 'Not?A_Brand', version: '24.0.0.0' },
      { brand: 'Chromium', version: `${major}.0.0.0` },
      { brand: 'Google Chrome', version: `${major}.0.0.0` },
    ],
    mobile: true,
    platform: 'Android',
    platformVersion: device.androidVersion || '16.0.0',
    model: device.model || 'Pixel 10',
    architecture: '',
    bitness: '',
    wow64: false,
  };
}

// Aplica UA + plataforma + userAgentData a una pagina via CDP (sin getters JS).
async function applyUaOverride(cdp, device, chromeMajor) {
  const uaMeta = uaMetadataFor(device, chromeMajor);
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: device.userAgent,
    acceptLanguage: 'en-US,en',
    platform: device.kind === 'android' ? 'Linux armv8l' : 'iPhone',
    ...(uaMeta ? { userAgentMetadata: uaMeta } : {}),
  });
}

const DEFAULT_SUPPORT_EMAIL = 'support@megapersonals.eu';

// Sal por MAQUINA: hace que cada PC genere huellas distintas aunque copien el config.
// Combina el nombre de la maquina + un id aleatorio persistente (por instalacion).
// Si el archivo .machine-id ya contiene un "salt completo" (con "|") o se define la
// variable MACHINE_SALT, se usa tal cual -> la huella es PORTABLE entre PCs.
const MACHINE_ID_PATH = path.join(__dirname, '.machine-id');
const MACHINE_SALT = (() => {
  if (process.env.MACHINE_SALT && process.env.MACHINE_SALT.includes('|')) return process.env.MACHINE_SALT;
  let raw = '';
  try { if (fs.existsSync(MACHINE_ID_PATH)) raw = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim(); } catch (_) {}
  if (raw && raw.includes('|')) return raw;
  let id = raw;
  if (!id) id = crypto.randomBytes(8).toString('hex');
  const salt = `${os.hostname()}|${id}`;
  try { fs.writeFileSync(MACHINE_ID_PATH, salt, 'utf8'); } catch (_) {}
  return salt;
})();

// --- API de control (maquina-a-maquina para el SaaS de renta) ---
const CONTROL_KEY_PATH = path.join(__dirname, '.control-key');
const CONTROL_API_KEY = (() => {
  if (process.env.CONTROL_API_KEY) return String(process.env.CONTROL_API_KEY);
  let k = '';
  try { if (fs.existsSync(CONTROL_KEY_PATH)) k = fs.readFileSync(CONTROL_KEY_PATH, 'utf8').trim(); } catch (_) {}
  if (!k) { k = crypto.randomBytes(16).toString('hex'); try { fs.writeFileSync(CONTROL_KEY_PATH, k, 'utf8'); } catch (_) {} }
  return k;
})();

function requireControlKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.key || (req.body && req.body.key);
  if (!key || key !== CONTROL_API_KEY) return res.status(401).json({ error: 'API key inválida.' });
  next();
}

const APP_VERSION = 18; // version de esta app (debe coincidir con el instalador MOMONGA-MEGA-Setup-N)
let versionDisponible = null; // { version, url } si el servidor tiene una mas nueva

// --- Licencia (para bots instalados en la PC del cliente) ---
const LICENSE_PATH = path.join(__dirname, '.license.json');
const DEFAULT_CLOUD = String(process.env.CLOUD_URL || 'https://mimomonga.uk').replace(/\/+$/, '');
let licencia = { cloudUrl: DEFAULT_CLOUD, token: '', data: null, checkedAt: 0 };
try { if (fs.existsSync(LICENSE_PATH)) { licencia = { ...licencia, ...JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8')) }; } } catch (_) {}
const guardarLicencia = () => { try { fs.writeFileSync(LICENSE_PATH, JSON.stringify(licencia, null, 2)); } catch (_) {} };
const licenciaRequerida = () => process.env.REQUIRE_LICENSE === '1' || Boolean(licencia.token);
const licenciaVigente = () => {
  if (!licenciaRequerida()) return true;
  const d = licencia.data;
  if (!d || d.vigente === false) return false;
  if (d.vence && new Date(d.vence).getTime() < Date.now()) return false;
  return true;
};
const limitePerfiles = () => (licencia.data && Number(licencia.data.perfiles)) || 0;
const puedeCrearPerfil = () => {
  if (!licenciaRequerida()) return true;
  if (!licenciaVigente()) return false;
  return controllers.size < limitePerfiles();
};
async function heartbeatLicencia() {
  if (!licencia.token) return;
  try {
    const r = await undiciFetch(`${licencia.cloudUrl || DEFAULT_CLOUD}/api/license/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: licencia.token }),
    });
    const data = await r.json().catch(() => ({}));
    if (data && data.licencia) { licencia.data = data.licencia; licencia.checkedAt = Date.now(); guardarLicencia(); }
    else if (r.status === 401) { licencia.token = ''; licencia.data = null; guardarLicencia(); }
  } catch (_) {}
}
if (licencia.token) {
  heartbeatLicencia().catch(() => {});
  setInterval(() => { heartbeatLicencia().catch(() => {}); }, 5 * 60 * 1000);
}

function photosDirDe(c) {
  const pp = c.cfg && c.cfg.adDetails && c.cfg.adDetails.photosPath;
  if (!pp) return null;
  try { const dir = path.resolve(__dirname, pp); return fs.existsSync(dir) ? dir : null; } catch (_) { return null; }
}

function contarFotos(c) {
  const dir = photosDirDe(c);
  if (!dir) return 0;
  try { return fs.readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).length; } catch (_) { return 0; }
}

async function generarThumb(c) {
  try {
    const dir = photosDirDe(c);
    if (!dir) { c._thumb = ''; return; }
    const files = fs.readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).sort();
    if (!files.length) { c._thumb = ''; return; }
    const buf = await sharp(path.join(dir, files[0])).resize(140, 140, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    c._thumb = `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (_) { c._thumb = ''; }
}

function thumbDe(c) {
  if (c._thumb === undefined) { c._thumb = ''; generarThumb(c).catch(() => {}); }
  return c._thumb;
}

function controlProfileState(c) {
  return {
    id: c.id,
    port: c.cfg?.port || null,
    state: !c.started ? 'stopped' : (c.paused ? 'paused' : 'running'),
    stage: c.cycleStage || '',
    detail: c.cycleDetail || '',
    bumpsToday: c.stats?.bumpsToday || 0,
    totalBumps: c.stats?.totalBumps || 0,
    proxy: c.cfg?.proxy ? `${c.cfg.proxy.host}:${c.cfg.proxy.port}` : '',
    device: c.cfg?.device || 'iphone',
    lastBumpAt: c.stats?.lastBumpAt || 0,
    nextBumpAt: c._nextBumpAt || 0,
    lastError: c.lastError || null,
    blocked: Boolean(c.blocked),
    bumpMinMinutes: c.cfg?.bumpMinMinutes || c.cfg?.intervalMinutes || 16,
    bumpMaxMinutes: c.cfg?.bumpMaxMinutes || c.cfg?.bumpMinMinutes || c.cfg?.intervalMinutes || 16,
    postsARotar: Math.max(0, Math.floor(Number(c.cfg?.postsARotar) || 0)),
    rotateAds: Boolean(c.cfg?.settings?.rotateAds),
    headline: (c.cfg?.adDetails?.headline || '').slice(0, 80),
    photos: contarFotos(c),
    thumb: thumbDe(c)
  };
}

// Perfil COMPLETO (para ver/editar desde el SaaS).
function controlProfileFull(c) {
  const p = c.cfg || {};
  const d = p.adDetails || {};
  return {
    id: c.id,
    port: p.port || null,
    state: !c.started ? 'stopped' : (c.paused ? 'paused' : 'running'),
    stage: c.cycleStage || '',
    detail: c.cycleDetail || '',
    bumpsToday: c.stats?.bumpsToday || 0,
    totalBumps: c.stats?.totalBumps || 0,
    device: p.device || 'iphone',
    nextBumpAt: c._nextBumpAt || 0,
    lastBumpAt: c.stats?.lastBumpAt || 0,
    lastError: c.lastError || null,
    blocked: Boolean(c.blocked),
    bumpMinMinutes: p.bumpMinMinutes || p.intervalMinutes || 16,
    bumpMaxMinutes: p.bumpMaxMinutes || p.bumpMinMinutes || p.intervalMinutes || 16,
    postsARotar: Math.max(0, Math.floor(Number(p.postsARotar) || 0)),
    apiKey2Captcha: p.apiKey2Captcha || '',
    rotateUrl: p.rotateUrl || '',
    email: p.email || '',
    settings: {
      rotateAds: Boolean(c.settings?.rotateAds),
      randomizedDelay: c.settings?.randomizedDelay !== false,
      publishOnStart: Boolean(c.settings?.publishOnStart)
    },
    schedule: p.schedule ? { enabled: Boolean(p.schedule.enabled), from: p.schedule.from || '08:00', to: p.schedule.to || '04:00', autoStart: p.schedule.autoStart !== false } : { enabled: false, from: '08:00', to: '04:00', autoStart: true },
    proxy: p.proxy ? { host: p.proxy.host, port: p.proxy.port, username: p.proxy.username || '', password: p.proxy.password || '', type: p.proxy.type || 'http' } : null,
    adDetails: {
      name: d.name || '', headline: d.headline || '', city: d.city || '', age: d.age || '',
      location: d.location || '', phone: d.phone || '', text: (d.text || '').slice(0, 400), photosPath: d.photosPath || '',
      iam: d.iam || 'A woman', isee: Array.isArray(d.isee) ? d.isee : ['Men']
    }
  };
}
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

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

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

// Modo cliente: el bot se instala en la PC del cliente; el login es la LICENCIA (no la contrasena local).
const CLIENT_MODE = process.env.REQUIRE_LICENSE === '1';

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/favicon.ico') return next();
  if (req.path === '/cliente') return next(); // panel del cliente (lo protege la licencia)
  if (/\.(png|jpe?g|gif|ico|svg|webp)$/i.test(req.path)) return next(); // imagenes/iconos (favicon, fondo)
  if (req.path.startsWith('/api/control/')) return next(); // API de control (se valida con API key)
  if (req.path.startsWith('/api/license/')) return next(); // Licencia del cliente (login propio)
  if (req.path.startsWith('/api/cliente/')) return next(); // Datos del panel del cliente
  if (CLIENT_MODE) return next(); // La licencia es el login; el cupo se valida en el servidor.
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado. Inicia sesión en el panel.' });
  return res.redirect('/login');
});

// --- API de control para el SaaS de renta (autenticada con API key) ---
app.get('/api/control/ping', requireControlKey, (req, res) => {
  res.json({ ok: true, service: 'momonga-bot', at: Date.now() });
});

app.get('/api/control/devices', requireControlKey, (req, res) => {
  const base = [
    { key: 'iphone', label: 'iPhone (Safari)' },
    { key: 'android', label: 'Android (genérico)' },
    { key: 'pixel', label: 'Pixel (genérico)' },
    { key: 'pixel_pro', label: 'Pixel Pro (genérico)' },
    { key: 'samsung', label: 'Samsung (genérico)' },
    { key: 'samsung_ultra', label: 'Samsung Ultra (genérico)' }
  ];
  let modern = [];
  try { modern = (typeof MODERN_ANDROID !== 'undefined' && Array.isArray(MODERN_ANDROID)) ? MODERN_ANDROID.map((d) => ({ key: d.key, label: d.label || d.key })) : []; } catch (_) {}
  res.json({ ok: true, devices: [...base, ...modern] });
});

app.get('/api/control/profiles', requireControlKey, (req, res) => {
  res.json({ ok: true, profiles: [...controllers.values()].map(controlProfileState) });
});

// Crear un perfil nuevo en el bot (desde el SaaS).
// --- API de licencia (para el panel del cliente) ---
app.get('/api/license/status', (req, res) => {
  res.json({
    ok: true,
    required: licenciaRequerida(),
    clientMode: CLIENT_MODE,
    cloudUrl: licencia.cloudUrl || DEFAULT_CLOUD,
    licencia: licencia.data,
    vigente: licenciaVigente(),
    perfilesActuales: controllers.size,
    perfilesPermitidos: limitePerfiles(),
    appVersion: APP_VERSION,
    versionDisponible: versionDisponible || null,
  });
});
app.post('/api/license/login', async (req, res) => {
  const { email, password, cloudUrl } = req.body || {};
  const base = String(cloudUrl || licencia.cloudUrl || DEFAULT_CLOUD).replace(/\/+$/, '');
  if (!email || !password) return res.status(400).json({ ok: false, mensaje: 'Escribe usuario y contrasena.' });
  try {
    const r = await undiciFetch(`${base}/api/license/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) return res.status(401).json({ ok: false, mensaje: (data && data.mensaje) || 'Credenciales invalidas.' });
    licencia = { cloudUrl: base, token: data.token, data: data.licencia, checkedAt: Date.now() };
    guardarLicencia();
    res.json({ ok: true, licencia: data.licencia });
  } catch (e) { res.status(502).json({ ok: false, mensaje: 'No se pudo conectar con la nube: ' + e.message }); }
});
app.post('/api/license/logout', (req, res) => { licencia.token = ''; licencia.data = null; guardarLicencia(); res.json({ ok: true }); });

// --- Panel ligero del cliente (tarjetas de perfiles, bloqueadas, correos) ---
app.get('/api/cliente/profiles', (req, res) => {
  try { res.json({ profiles: [...controllers.values()].map(controlProfileState) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
const CORREOS_PATH = path.join(__dirname, '.correos.json');
const leerCorreos = () => { try { if (fs.existsSync(CORREOS_PATH)) return JSON.parse(fs.readFileSync(CORREOS_PATH, 'utf8')); } catch (_) {} return []; };
app.get('/api/cliente/correos', (req, res) => res.json({ correos: leerCorreos() }));
app.post('/api/cliente/correos', (req, res) => {
  const lista = Array.isArray(req.body && req.body.correos) ? req.body.correos.map((x) => String(x || '').trim()).filter(Boolean) : [];
  try { fs.writeFileSync(CORREOS_PATH, JSON.stringify(lista, null, 2)); } catch (_) {}
  res.json({ ok: true, correos: lista });
});
app.post('/api/cliente/update', async (req, res) => {
  try { res.json(await aplicarActualizacion()); }
  catch (e) { res.status(500).json({ ok: false, mensaje: e.message }); }
});
app.get('/api/cliente/devices', (req, res) => {
  const base = [
    { key: 'iphone', label: 'iPhone (Safari)' },
    { key: 'android', label: 'Android (genérico)' },
    { key: 'pixel', label: 'Pixel (genérico)' },
    { key: 'pixel_pro', label: 'Pixel Pro (genérico)' },
    { key: 'samsung', label: 'Samsung (genérico)' },
    { key: 'samsung_ultra', label: 'Samsung Ultra (genérico)' },
  ];
  let modern = [];
  try { modern = (typeof MODERN_ANDROID !== 'undefined' && Array.isArray(MODERN_ANDROID)) ? MODERN_ANDROID.map((d) => ({ key: d.key, label: d.label || d.key })) : []; } catch (_) {}
  res.json({ devices: [...base, ...modern] });
});
app.post('/api/cliente/mail/open', async (req, res) => {
  try { res.json(await openMailBrowser(String((req.body && req.body.id) || '').trim(), String((req.body && req.body.url) || '').trim())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cliente/mail/close', async (req, res) => {
  try { res.json(await closeMailBrowser(String((req.body && req.body.id) || '').trim())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cliente/profile/:id/:action', async (req, res) => {
  const controller = controllers.get(req.params.id);
  if (!controller) return res.status(404).json({ error: 'Perfil no encontrado.' });
  const a = req.params.action;
  try {
    if (a === 'open') await controller.open();
    else if (a === 'start') controller.start();
    else if (a === 'pause') { if (controller.paused) controller.resume(); else controller.pause(); }
    else if (a === 'stop') controller.stop();
    else if (a === 'publish') controller.publishNow();
    else return res.status(400).json({ error: 'Accion invalida.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/cliente/all/:action', (req, res) => {
  const a = req.params.action;
  try {
    for (const c of controllers.values()) {
      if (a === 'open') c.open();
      else if (a === 'start') c.start();
      else if (a === 'pause') c.pause();
      else if (a === 'resume') { if (c.started) c.resume(); else c.start(); }
      else if (a === 'publish') c.publishNow();
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/cliente', (req, res) => {
  const f = path.join(__dirname, 'public', 'cliente.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/control/profiles', requireControlKey, (req, res) => {
  try {
    if (!puedeCrearPerfil()) {
      const msg = !licenciaVigente()
        ? 'Tu licencia no esta vigente. Renueva para crear perfiles.'
        : `Alcanzaste el limite de ${limitePerfiles()} perfil(es) de tu licencia.`;
      return res.status(403).json({ ok: false, error: msg });
    }
    const body = req.body || {};
    const cleanId = String(body.id || '').trim();
    if (!cleanId) return res.status(400).json({ ok: false, error: 'Falta el nombre del perfil.' });
    if (/[\\/:*?"<>|]/.test(cleanId)) return res.status(400).json({ ok: false, error: 'El nombre no puede tener: \\ / : * ? " < > |' });
    const config = loadConfig();
    if (config.some((p) => p.id === cleanId)) return res.status(409).json({ ok: false, error: 'Ya existe un perfil con ese nombre.' });

    let port = Number(body.port);
    const usedPorts = new Set(config.map((p) => Number(p.port)));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      port = 9334; while (usedPorts.has(port)) port += 1;
    } else if (usedPorts.has(port)) {
      return res.status(409).json({ ok: false, error: 'Ese puerto ya está en uso.' });
    }

    const min = Math.max(1, Math.floor(Number(body.bumpMinMinutes) || 16));
    const max = Math.max(min, Math.floor(Number(body.bumpMaxMinutes) || min));
    const np = {
      id: cleanId, port,
      email: '', password: '', supportEmail: '', supportUrl: '',
      intervalMinutes: min, bumpMinMinutes: min, bumpMaxMinutes: max,
      postsARotar: Math.max(0, Math.floor(Number(body.postsARotar) || 0)),
      url: String(body.url || DEFAULT_URL).trim() || DEFAULT_URL,
      device: isValidDevice(body.device) ? body.device : 'iphone',
      settings: {
        rotateAds: body.rotateAds !== false,
        randomizedDelay: body.randomizedDelay !== false,
        publishOnStart: Boolean(body.publishOnStart)
      },
      adDetails: { name: '', headline: '', city: '', age: '', location: '', phone: '', text: '', textVariants: [], headlineVariants: [], photosPath: '', iam: 'A woman', isee: ['Men'] },
      apiKey2Captcha: String(body.apiKey2Captcha || '').trim(),
      rotateUrl: String(body.rotateUrl || '').trim(),
      limits: { dailyLimit: 0, conservativeMode: false }
    };
    if (body.proxy && body.proxy.host) {
      np.proxy = { host: String(body.proxy.host).trim(), port: Number(body.proxy.port) || 0, username: String(body.proxy.username || ''), password: String(body.proxy.password || ''), type: body.proxy.type === 'socks5' ? 'socks5' : 'http' };
    }
    config.push(np);
    saveConfig(config);
    controllers.set(np.id, new ProfileController(np));
    io.emit('profiles-updated', config);
    res.status(201).json({ ok: true, profile: controlProfileFull(controllers.get(np.id)) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/control/profiles/:id', requireControlKey, (req, res) => {
  const c = controllers.get(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
  res.json({ ok: true, profile: controlProfileFull(c) });
});

app.post('/api/control/profiles/:id/rename', requireControlKey, async (req, res) => {
  try {
    const oldId = String(req.params.id || '');
    const newId = String((req.body || {}).newId || '').trim();
    if (!newId) return res.status(400).json({ ok: false, error: 'Escribe un nombre.' });
    if (newId === oldId) return res.json({ ok: true, id: newId });
    if (/[\\/:*?"<>|]/.test(newId)) return res.status(400).json({ ok: false, error: 'Nombre con caracteres inválidos.' });
    const config = loadConfig();
    const profile = config.find((x) => x.id === oldId);
    if (!profile) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    if (config.some((x) => x.id === newId)) return res.status(409).json({ ok: false, error: 'Ya existe un perfil con ese nombre.' });
    const controller = controllers.get(oldId);
    if (controller) { try { await controller.stop(); } catch (_) {} controllers.delete(oldId); }
    const oldDir = path.join(__dirname, 'profiles', `perfil_${oldId}`);
    const newDir = path.join(__dirname, 'profiles', `perfil_${newId}`);
    try { if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) fs.renameSync(oldDir, newDir); } catch (_) {}
    profile.id = newId;
    saveConfig(config);
    if (controller) { controller.cfg = profile; controller.id = newId; controllers.set(newId, controller); }
    else controllers.set(newId, new ProfileController(profile));
    io.emit('profiles-updated', config);
    saveState();
    res.json({ ok: true, id: newId });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch('/api/control/profiles/:id', requireControlKey, (req, res) => {
  try {
    const controller = controllers.get(req.params.id);
    if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    const config = loadConfig();
    const profile = config.find((x) => x.id === req.params.id);
    if (!profile) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    const body = req.body || {};
    if ('bumpMinMinutes' in body || 'bumpMaxMinutes' in body) {
      const min = Math.max(1, Math.floor(Number(body.bumpMinMinutes) || profile.bumpMinMinutes || 16));
      const max = Math.max(min, Math.floor(Number(body.bumpMaxMinutes) || profile.bumpMaxMinutes || min));
      profile.bumpMinMinutes = min; profile.bumpMaxMinutes = max; profile.intervalMinutes = min;
      Object.assign(controller.cfg, { bumpMinMinutes: min, bumpMaxMinutes: max, intervalMinutes: min });
      if (controller.started && !controller.paused) controller.scheduleNext();
    }
    if ('device' in body) {
      profile.device = isValidDevice(body.device) ? body.device : 'iphone';
      controller.cfg.device = profile.device;
    }
    if ('apiKey2Captcha' in body) {
      profile.apiKey2Captcha = String(body.apiKey2Captcha || '').trim();
      controller.cfg.apiKey2Captcha = profile.apiKey2Captcha;
    }
    if ('rotateUrl' in body) {
      profile.rotateUrl = String(body.rotateUrl || '').trim();
      controller.cfg.rotateUrl = profile.rotateUrl;
    }

    if ('email' in body) {
      profile.email = String(body.email || '').trim();
      controller.cfg.email = profile.email;
    }
    if ('postsARotar' in body) {
      const n = Math.max(0, Math.floor(Number(body.postsARotar) || 0));
      profile.postsARotar = n;
      controller.cfg.postsARotar = n;
    }
    if ('rotateAds' in body || 'randomizedDelay' in body || 'publishOnStart' in body) {
      profile.settings = {
        rotateAds: 'rotateAds' in body ? Boolean(body.rotateAds) : Boolean(profile.settings?.rotateAds),
        randomizedDelay: 'randomizedDelay' in body ? Boolean(body.randomizedDelay) : (profile.settings ? profile.settings.randomizedDelay !== false : true),
        publishOnStart: 'publishOnStart' in body ? Boolean(body.publishOnStart) : Boolean(profile.settings?.publishOnStart)
      };
      controller.settings = { ...profile.settings };
    }
    if (body.schedule && typeof body.schedule === 'object') {
      profile.schedule = {
        enabled: Boolean(body.schedule.enabled),
        from: String(body.schedule.from || '08:00'),
        to: String(body.schedule.to || '04:00'),
        autoStart: body.schedule.autoStart !== false
      };
      controller.cfg.schedule = profile.schedule;
    }
    if ('proxy' in body) {
      const parsed = parseProxy(body.proxy);
      if (!parsed) delete profile.proxy; else profile.proxy = parsed;
      controller.cfg.proxy = profile.proxy;
    }
    if (body.adDetails && typeof body.adDetails === 'object') {
      const d = profile.adDetails || {};
      const pick = (k, v) => (k in body.adDetails ? String(body.adDetails[k] || '') : (v || ''));
      const nd = {
        name: pick('name', d.name).trim(),
        headline: pick('headline', d.headline).trim(),
        city: pick('city', d.city).trim(),
        age: pick('age', d.age).trim(),
        location: pick('location', d.location).trim(),
        phone: pick('phone', d.phone).trim(),
        text: pick('text', d.text),
        photosPath: pick('photosPath', d.photosPath).trim(),
        iam: ('iam' in body.adDetails ? String(body.adDetails.iam || '') : (d.iam || 'A woman')).trim(),
        isee: Array.isArray(body.adDetails.isee) ? body.adDetails.isee.map((v) => String(v || '')).filter(Boolean) : (Array.isArray(d.isee) ? d.isee : ['Men']),
        textVariants: Array.isArray(d.textVariants) ? d.textVariants : [],
        headlineVariants: Array.isArray(d.headlineVariants) ? d.headlineVariants : []
      };
      profile.adDetails = nd;
      controller.cfg.adDetails = nd;
    }
    saveConfig(config);
    io.emit('profiles-updated', config);
    res.json({ ok: true, profile: controlProfileFull(controller) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Devuelve las fotos actuales del perfil (base64) para verlas/editar en el SaaS.
app.get('/api/control/profiles/:id/photos', requireControlKey, (req, res) => {
  try {
    const dir = path.join(__dirname, 'profiles', req.params.id, 'photos');
    let fotos = [];
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).sort();
      fotos = files.map((n) => {
        const buf = fs.readFileSync(path.join(dir, n));
        const ext = n.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        return `data:${mime};base64,${buf.toString('base64')}`;
      });
    }
    res.json({ ok: true, fotos });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Recibe las fotos del anuncio (base64/dataURL) desde el SaaS y las guarda en
// profiles/<id>/photos, dejando el adDetails.photosPath listo para el proximo repost.
app.post('/api/control/profiles/:id/photos', requireControlKey, (req, res) => {
  try {
    const id = req.params.id;
    const controller = controllers.get(id);
    const config = loadConfig();
    const profile = config.find((x) => x.id === id);
    if (!controller || !profile) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });

    const fotos = Array.isArray(req.body && req.body.fotos) ? req.body.fotos.filter(Boolean).slice(0, 12) : [];
    const targetDir = path.join(__dirname, 'profiles', id, 'photos');
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of fs.readdirSync(targetDir)) {
      try { fs.unlinkSync(path.join(targetDir, name)); } catch (_) {}
    }

    let saved = 0;
    fotos.forEach((dataUrl, i) => {
      const raw = String(dataUrl || '');
      const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      let buffer = null;
      if (m) buffer = Buffer.from(m[2], 'base64');
      else if (!raw.startsWith('data:') && raw.length > 100) buffer = Buffer.from(raw, 'base64');
      if (!buffer || !buffer.length) return;
      const ext = m && /png/i.test(m[1]) ? 'png' : (m && /webp/i.test(m[1]) ? 'webp' : 'jpg');
      fs.writeFileSync(path.join(targetDir, `photo-${i + 1}.${ext}`), buffer);
      saved++;
    });

    const photosPath = saved > 0 ? `profiles/${id}/photos` : '';
    if (!profile.adDetails) profile.adDetails = {};
    profile.adDetails.photosPath = photosPath;
    if (controller.cfg.adDetails) controller.cfg.adDetails.photosPath = photosPath;
    saveConfig(config);
    controller.log(`🖼️ ${saved} foto(s) recibidas del SaaS -> ${photosPath || '(vacío)'}`);
    try { controller._thumb = undefined; } catch (_) {}
    res.json({ ok: true, photosPath, saved });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Notificaciones (Telegram/Discord) para avisar errores al móvil, editables desde el SaaS.
app.get('/api/control/notify', requireControlKey, (req, res) => {
  const cfg = loadNotifyConfig();
  res.json({ ok: true, notify: { telegramToken: cfg.telegramToken || '', telegramChatId: cfg.telegramChatId || '', discordWebhook: cfg.discordWebhook || '' } });
});

app.patch('/api/control/notify', requireControlKey, (req, res) => {
  try {
    const cfg = {
      telegramToken: String(req.body?.telegramToken || '').trim(),
      telegramChatId: String(req.body?.telegramChatId || '').trim(),
      discordWebhook: String(req.body?.discordWebhook || '').trim()
    };
    saveNotifyConfig(cfg);
    res.json({ ok: true, notify: cfg });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/control/notify/test', requireControlKey, async (req, res) => {
  try {
    const actual = loadNotifyConfig();
    const cfg = {
      telegramToken: String(req.body?.telegramToken || actual.telegramToken || '').trim(),
      telegramChatId: String(req.body?.telegramChatId || actual.telegramChatId || '').trim(),
      discordWebhook: String(req.body?.discordWebhook || actual.discordWebhook || '').trim()
    };
    if (cfg.telegramToken || cfg.discordWebhook) saveNotifyConfig(cfg);
    if (!cfg.telegramToken && !cfg.discordWebhook) return res.status(400).json({ ok: false, error: 'Falta el token y el chat ID de Telegram.' });
    await notify('✅ Prueba de notificación. ¡Funciona!');
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Accion (start/pause/resume/stop) sobre TODOS los perfiles a la vez.
// Apelacion por Contact Us en navegador limpio (solo el correo). Para cuentas que fallaron al registrar.
app.post('/api/control/appeal-clean', requireControlKey, async (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const apiKey = String(body.apiKey || process.env.TWOCAPTCHA_KEY || '').trim();
    const proxy = body.proxy && body.proxy.host ? body.proxy : null;
    if (!email) return res.status(400).json({ ok: false, error: 'Falta el email.' });
    const r = await appealContactUsClean(email, apiKey, proxy);
    res.json(r);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/control/appeal-clean-all', requireControlKey, async (req, res) => {
  try {
    const body = req.body || {};
    const apiKey = String(body.apiKey || process.env.TWOCAPTCHA_KEY || '').trim();
    const proxy = body.proxy && body.proxy.host ? body.proxy : null;
    const r = await appealContactUsAll(body.emails, apiKey, proxy);
    res.json(r);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/control/mail/open', requireControlKey, async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'Falta el correo.' });
    res.json(await openMailBrowser(id));
  } catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});
app.post('/api/control/mail/close', requireControlKey, async (req, res) => {
  try { res.json(await closeMailBrowser(String((req.body && req.body.id) || '').trim())); }
  catch (error) { res.status(500).json({ ok: false, error: error.message }); }
});
app.get('/api/control/mail/list', requireControlKey, (req, res) => res.json({ ok: true, abiertos: [...mailBrowsers.keys()] }));
app.get('/api/control/mail/status', requireControlKey, async (req, res) => {
  try { res.json(await mailStatus()); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Diagnostico temporal: abre BrowserScan bot-detection en el perfil y devuelve el resultado.
app.get('/api/control/profiles/:id/diagnose', requireControlKey, async (req, res) => {
  try {
    const controller = controllers.get(String(req.params.id));
    if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    if (!controller.browser) { try { await controller.open(); } catch (_) {} await sleep(4000); }
    if (!controller.browser) return res.status(500).json({ ok: false, error: 'No se pudo abrir el navegador.' });
    const page = await controller.browser.newPage();
    if (typeof controller._applyPage === 'function') await controller._applyPage(page);
    await page.goto('https://www.browserscan.net/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(16000);
    const info = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return {
        bot: /No Detection/i.test(t) ? 'No Detection' : (/\bBot Detection:?\s*Yes/i.test(t) ? 'Yes' : null),
        score: (t.match(/(\d{1,3})\s*%/) || [])[1] || null,
        penalties: (t.match(/[A-Z][A-Za-z ]{2,28}\s*[-\u2212]\d{1,2}%/g) || []),
        text: t.slice(0, 4000),
        jsTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        langs: navigator.languages,
        platform: navigator.platform,
        uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
      };
    }).catch(() => ({ bot: null, text: '' }));
    await page.close().catch(() => {});
    res.json({ ok: true, ...info });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Chequeo externo en ip2location / browserleaks / scamalytics / browserscan.
app.get('/api/control/profiles/:id/check', requireControlKey, async (req, res) => {
  try {
    const controller = controllers.get(String(req.params.id));
    if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    res.json(await runExternalCheck(controller));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Chequeo de detección (sannysoft / creepjs / detector de extensiones).
app.get('/api/control/profiles/:id/detect', requireControlKey, async (req, res) => {
  try {
    const controller = controllers.get(String(req.params.id));
    if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    res.json(await runDetect(controller));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// IP real de SALIDA del proxy (rápido, sin abrir navegador).
app.get('/api/control/profiles/:id/exitip', requireControlKey, async (req, res) => {
  try {
    const c = controllers.get(String(req.params.id));
    if (!c) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    res.json({ ok: true, ...(await lookupExitIp(c.cfg.proxy)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/control/all/:action', requireControlKey, async (req, res) => {
  const action = String(req.params.action || '').toLowerCase();
  const results = [];
  for (const c of controllers.values()) {
    try {
      if (action === 'start' || action === 'iniciar') await c.start();
      else if (action === 'resume' || action === 'reanudar') { if (c.started) c.resume(); else await c.start(); }
      else if (action === 'pause' || action === 'pausar') c.pause();
      else if (action === 'stop' || action === 'detener') await c.stop();
      else return res.status(400).json({ ok: false, error: `Acción desconocida: ${action}` });
      results.push({ id: c.id, ok: true });
    } catch (e) {
      results.push({ id: c.id, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, action, total: results.length, results });
});

app.delete('/api/control/profiles/:id', requireControlKey, async (req, res) => {
  try {
    const config = loadConfig();
    const index = config.findIndex((x) => x.id === req.params.id);
    if (index === -1) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    const controller = controllers.get(req.params.id);
    if (controller) { try { await controller.stop(); } catch (_) {} controllers.delete(req.params.id); }
    config.splice(index, 1);
    saveConfig(config, { allowEmpty: true });
    try { removeProfileFolders(req.params.id); } catch (_) {}
    io.emit('profiles-updated', config);
    saveState();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Importar el anuncio real (datos + fotos sin EXIF). Debe ir ANTES de la ruta generica :action.
app.post('/api/control/profiles/:id/import', requireControlKey, async (req, res) => {
  try {
    const controller = controllers.get(req.params.id);
    if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
    if (!controller.page) { await controller.open().catch(() => {}); }
    if (!controller.page) return res.status(400).json({ ok: false, error: 'No se pudo abrir el navegador del perfil (revisa el proxy).' });

    // Captura las respuestas de las fotos del anuncio (CDN drome6) mientas el navegador las carga.
    const photoBuffers = new Map();
    const onResp = (resp) => {
      try {
        const u = resp.url();
        if (/drome6\.com\/imgs\//i.test(u)) {
          resp.buffer().then((b) => { if (b && b.length) photoBuffers.set(u, b); }).catch(() => {});
        }
      } catch (_) {}
    };
    controller.page.on('response', onResp);
    try {
      await controller.page.goto(siteUrls(controller).manage, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(1500);
      const data = await scrapeAndSaveAd(controller, photoBuffers);
      res.json({ ok: true, data });
    } finally {
      try { controller.page.off('response', onResp); } catch (_) {}
    }
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Imagen (captura) del ultimo bloqueo de este perfil.
app.get('/api/control/profiles/:id/block-image', requireControlKey, (req, res) => {
  try {
    const id = req.params.id;
    let files = [];
    try { files = fs.readdirSync(APPEALS_DIR).filter((f) => f.startsWith(`${id}-`) && f.endsWith('.png')).sort(); } catch (_) {}
    if (!files.length) return res.json({ ok: true, image: '' });
    const buf = fs.readFileSync(path.join(APPEALS_DIR, files[files.length - 1]));
    res.json({ ok: true, image: `data:image/png;base64,${buf.toString('base64')}` });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Logs recientes de un perfil (ultimas ~250 lineas que mencionan ese id).
app.get('/api/control/profiles/:id/logs', requireControlKey, (req, res) => {
  try {
    const id = req.params.id;
    const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')).sort();
    let out = [];
    for (let i = files.length - 1; i >= 0 && out.length < 250; i--) {
      let content = '';
      try { content = fs.readFileSync(path.join(LOGS_DIR, files[i]), 'utf8'); } catch (_) { continue; }
      const lines = content.split('\n').filter((l) => l.includes(`[${id}]`));
      out = [...lines.reverse(), ...out];
    }
    res.json({ ok: true, id, lines: out.slice(-250) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/control/profiles/:id/:action', requireControlKey, async (req, res) => {
  const controller = controllers.get(req.params.id);
  if (!controller) return res.status(404).json({ ok: false, error: 'Perfil no encontrado.' });
  const action = String(req.params.action || '').toLowerCase();
  try {
    if (action === 'start' || action === 'iniciar') controller.start();
    else if (action === 'pause' || action === 'pausar') controller.pause();
    else if (action === 'resume' || action === 'reanudar') { if (controller.started) controller.resume(); else controller.start(); }
    else if (action === 'stop' || action === 'detener') controller.stop();
    else if (action === 'publish' || action === 'publicar') {
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const minMin = Math.max(1, Number(controller.cfg.bumpMinMinutes || controller.cfg.intervalMinutes || 16));
      const minMs = minMin * 60 * 1000;
      const last = (controller.stats && controller.stats.lastBumpAt) || 0;
      const resta = last ? (minMs - (Date.now() - last)) : 0;
      if (!force && last && resta > 0) {
        return res.status(429).json({
          ok: false,
          error: `Todavía no toca bump: faltan ${Math.ceil(resta / 60000)} min (intervalo ${minMin} min).`,
          waitMin: Math.ceil(resta / 60000),
          profile: controlProfileState(controller)
        });
      }
      if (!controller.started) { try { await controller.start(); } catch (_) {} }
      controller.publishNow();
    }
    else if (action === 'repost' || action === 'republicar' || action === 'edit-existing' || action === 'editar-post') {
      const force = req.query.force === '1' || (req.body && req.body.force === true);
      const minMin = Math.max(1, Number(controller.cfg.bumpMinMinutes || controller.cfg.intervalMinutes || 16));
      const minMs = minMin * 60 * 1000;
      const last = (controller.stats && controller.stats.lastBumpAt) || 0;
      const resta = last ? (minMs - (Date.now() - last)) : 0;
      if (!force && last && resta > 0) {
        // Editar tambien "sube" el anuncio: si aun no toca, se aplica en la proxima publicacion.
        controller._pendingEdit = true;
        return res.json({
          ok: true,
          deferred: true,
          waitMin: Math.ceil(resta / 60000),
          mensaje: `Los cambios se guardaron y se aplicaran en la proxima publicacion (en ~${Math.ceil(resta / 60000)} min).`,
          profile: controlProfileState(controller)
        });
      }
      controller._pendingEdit = false;
      (async () => {
        try {
          if (!controller.page) await controller.open();
          if (controller.page) {
            controller._operationPromise = editExistingPost(controller.page, controller, { strict: true });
            await controller._operationPromise.catch(() => {});
            controller._operationPromise = null;
          }
        } catch (e) { controller.log(`⚠️ Editar post falló: ${e.message}`); }
      })();
    }
    else if (action === 'open' || action === 'abrir') controller.open();
    else if (action === 'create-post' || action === 'crear-post' || action === 'write-new' || action === 'nuevo') {
      (async () => {
        try {
          if (!controller.page) await controller.open();
          if (controller.page) {
            controller._operationPromise = editExistingPost(controller.page, controller, { forceCreate: true });
            await controller._operationPromise.catch(() => {});
            controller._operationPromise = null;
          }
        } catch (e) { controller.log(`⚠️ Crear post falló: ${e.message}`); }
      })();
    }
    else if (action === 'remove-post' || action === 'remover-post' || action === 'remove' || action === 'delete-post' || action === 'eliminar-post') {
      (async () => {
        try {
          if (!controller.page) await controller.open();
          if (controller.page) {
            controller._operationPromise = removePost(controller.page, controller);
            await controller._operationPromise.catch(() => {});
            controller._operationPromise = null;
          }
        } catch (e) { controller.log(`⚠️ Remover post falló: ${e.message}`); }
      })();
    }
    else if (action === 'unblock' || action === 'desbloquear' || action === 'desmarcar-bloqueada') {
      controller.blocked = false;
      saveState();
      controller.log('✅ Perfil desmarcado como bloqueado. Ya se puede Iniciar de nuevo.');
      notify(`✅ La cuenta "${controller.id}" se desmarcó como bloqueada (lista para reintentar).`);
    }
    else if (action === 'block' || action === 'bloquear' || action === 'marcar-bloqueada') {
      controller.blocked = true;
      saveState();
      controller.log('🚫 Perfil marcado como BLOQUEADO (a petición del panel).');
      notify(`🚫 La cuenta "${controller.id}" se marcó como bloqueada (por reusar foto/número).`);
    }
    else if (action === 'appeal' || action === 'apelar') {
      (async () => {
        try {
          if (!controller.page) await controller.open();
          if (controller.page) {
            controller._operationPromise = appealSupportForm(controller.page, controller);
            await controller._operationPromise.catch(() => {});
            controller._operationPromise = null;
          }
        } catch (e) { controller.log(`⚠️ Apelar falló: ${e.message}`); }
      })();
    }
    else if (action === 'appeal-open' || action === 'abrir-apelacion') {
      (async () => {
        try {
          if (!controller.page) await controller.open();
          if (controller.page) {
            let origin = 'https://megapersonals.eu';
            try { origin = new URL(siteUrls(controller).list).origin; } catch (_) {}
            const permitidos = ['/public/support_request', '/public/scam_request', '/reset_user_password'];
            const pedido = String((req.body && req.body.path) || '').trim();
            const ruta = permitidos.includes(pedido) ? pedido : permitidos[0];
            await controller.page.goto(`${origin}${ruta}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            controller.log(`📨 Abrí ${ruta} en el navegador del perfil.`);
          }
        } catch (e) { controller.log(`⚠️ Abrir apelación falló: ${e.message}`); }
      })();
    }
    else if (action === 'verify' || action === 'verificar') {
      // Primero el chequeo de los 4 enlaces (abre el navegador si hace falta) y luego el rápido.
      let external = null;
      try { external = await runExternalCheck(controller); } catch (_) {}
      const check = await runSafetyCheck(controller).catch(() => null);
      if (check) reportSafetyCheck(controller, check);
      return res.json({ ok: Boolean(check && check.ok), result: check || null, external, profile: controlProfileState(controller) });
    } else {
      return res.status(400).json({ ok: false, error: `Acción desconocida: ${action}` });
    }
    await sleep(500);
    res.json({ ok: true, action, profile: controlProfileState(controller) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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
    if (c.rotateUrl) c.rotateUrl = fn(c.rotateUrl);
    if (c.proxy && c.proxy.password) c.proxy = { ...c.proxy, password: fn(c.proxy.password) };
    return c;
  });
}

function saveConfig(config, opts = {}) {
  // Candado anti-perdida: no sobrescribir con un array vacio si ya habia perfiles.
  if (Array.isArray(config) && config.length === 0 && !opts.allowEmpty) {
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { existing = []; }
    if (Array.isArray(existing) && existing.length > 0) {
      console.error('⚠️ saveConfig: intento de guardar config VACIO con perfiles existentes; OMITIDO.');
      logToFile('server', 'saveConfig vacio omitido (habia perfiles).');
      notify('⚠️ Se evito guardar una config vacia (proteccion anti-perdida de perfiles).');
      return;
    }
  }
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
  if (list.length === 0) return '💀 *MOMONGA PRO*\n\nNo hay cuentas configuradas.';
  const active = list.filter((c) => c.started && !c.paused).length;
  const paused = list.filter((c) => c.started && c.paused).length;
  const stopped = list.length - active - paused;
  const bumps = list.reduce((s, c) => s + (c.stats.bumpsToday || 0), 0);
  const now = new Date().toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const lines = list.map((c) => {
    const dot = !c.started ? '⚪' : (c.paused ? '⏸️' : '🟢');
    const extra = c.started && !c.paused ? `  ·  ${c.stats.bumpsToday || 0} bumps` : '';
    return `${dot} *${c.id}*${extra}`;
  });
  return [
    '💀 *MOMONGA PRO*',
    '━━━━━━━━━━━━━━━━━━',
    `🟢 Activos *${active}*    ⏸️ Pausados *${paused}*    ⚪ Detenidos *${stopped}*`,
    `📈 Bumps hoy *${bumps}*        🕐 ${now}`,
    '',
    '📋 *Cuentas* — toca una para abrirla',
    ...lines
  ].join('\n');
}

function accountsKeyboard() {
  const rows = [
    [
      { text: '🖼️ Ver panel', callback_data: 'panel' },
      { text: '🔄 Actualizar', callback_data: 'menu' }
    ],
    [
      { text: '▶️ Iniciar todos', callback_data: 'all:start' },
      { text: '⏸️ Pausar todos', callback_data: 'all:pause' },
      { text: '⏹️ Detener todos', callback_data: 'all:stop' }
    ]
  ];
  for (const c of controllers.values()) {
    const dot = !c.started ? '⚪' : (c.paused ? '⏸️' : '🟢');
    const id = String(c.id).slice(0, 40);
    rows.push([{ text: `${dot} ${id}`, callback_data: `view:${id}` }]);
  }
  return { inline_keyboard: rows };
}

function tgViewKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: '▶️ Iniciar', callback_data: `start:${id}` },
        { text: '⏸️ Pausar', callback_data: `pause:${id}` },
        { text: '⏹️ Detener', callback_data: `stop:${id}` }
      ],
      [
        { text: '📢 Publicar', callback_data: `publish:${id}` },
        { text: '📺 Vista en vivo', callback_data: `live:${id}` }
      ],
      [
        { text: '🔄 Refrescar', callback_data: `view:${id}` },
        { text: '⬅️ Volver', callback_data: 'menu' }
      ]
    ]
  };
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
  const c = controllers.get(id);
  const estado = c ? (!c.started ? '⚪ Detenido' : (c.paused ? '⏸️ Pausado' : '🟢 Activo')) : '—';
  return [
    `👤 *${p.id}*`,
    `Estado: *${estado}*${c && c.started ? `   ·   bumps hoy: *${c.stats.bumpsToday || 0}*` : ''}`,
    '━━━━━━━━━━━━━━━━━━',
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
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  let aviso = '';
  try {
    if (action === 'view') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id });
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: tgView(id), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: tgViewKeyboard(id) });
      return;
    }
    if (action === 'panel') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Generando captura...' });
      await tgSendPanelScreenshot(token, chatId);
      return;
    }
    if (action === 'live') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Abriendo vista en vivo...' });
      await startTgLive(token, chatId, id);
      return;
    }
    if (action === 'stoplive') {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Deteniendo vista...' });
      stopTgLive(chatId, id);
      return;
    }
    if (action === 'all' && id === 'start') { for (const c of controllers.values()) c.start(); aviso = '▶️ Iniciando todas...'; }
    else if (action === 'all' && id === 'pause') { for (const c of controllers.values()) c.pause(); aviso = '⏸️ Pausando todas...'; }
    else if (action === 'all' && id === 'stop') { for (const c of controllers.values()) c.stop(); aviso = '⏹️ Deteniendo todas...'; }
    else if (controller && action === 'start') { controller.start(); aviso = `🟢 ${id}: iniciando...`; }
    else if (controller && action === 'pause') { if (controller.paused) controller.resume(); else controller.pause(); aviso = `${controller.paused ? '⏸️' : '▶️'} ${id}: ${controller.paused ? 'pausado' : 'reanudado'}`; }
    else if (controller && action === 'stop') { controller.stop(); aviso = `⚪ ${id}: detenido`; }
    else if (controller && action === 'publish') { controller.publishNow(); aviso = `📢 ${id}: publicando...`; }
  } catch (error) {
    aviso = `Error: ${error.message}`;
  }
  await tgCall(token, 'answerCallbackQuery', { callback_query_id: query.id, text: aviso || 'ok' });

  // Accion sobre una cuenta -> refresca su ficha; si no, el menu.
  const perAccount = controller && ['start', 'pause', 'stop', 'publish'].includes(action);
  if (perAccount) {
    const r = await tgCall(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: tgView(id), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: tgViewKeyboard(id) });
    if (r && r.ok === false) await tgCall(token, 'sendMessage', { chat_id: chatId, text: tgView(id), parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: tgViewKeyboard(id) });
  } else {
    await showAccountsMenu(token, chatId, messageId);
  }
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
        variantIndex: controller.variantIndex || {},
        lastPhotoHash: controller.lastPhotoHash || null,
        blocked: Boolean(controller.blocked)
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

// Pausa "humana": tiempo aleatorio para no parecer un bot (evita bloqueos por automatizacion).
async function humanPause(min = 500, max = 1600) {
  const ms = min + Math.random() * Math.max(0, max - min);
  return sleep(Math.round(ms));
}

// ¿Estamos dentro del horario de trabajo? (from/to en "HH:MM"; soporta cruzar medianoche)
function dentroHorario(from, to, d = new Date()) {
  const toMin = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const a = toMin(from);
  const b = toMin(to);
  if (a == null || b == null || a === b) return true;
  const now = d.getHours() * 60 + d.getMinutes();
  return a < b ? (now >= a && now < b) : (now >= a || now < b);
}

// Deja solo el numero de telefono (quita "City : ...", "Location : ...", etc.).
function soloTelefono(v) {
  const s = String(v == null ? '' : v);
  const m = s.match(/\+?\d[\d\s().-]{6,}\d/);
  return m ? m[0].replace(/\s+/g, ' ').trim() : '';
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
      // La imagen del captcha debe estar REALMENTE cargada (ancho Y alto, y natural>0 en IMG).
      // Si no, manda una imagen rota y 2Captcha devuelve basura ("CAPTCHA").
      const usable = (el) => {
        if (!el || el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 10 || r.height <= 10) return false;
        if (el.tagName === 'IMG' && (!el.naturalWidth || !el.naturalHeight)) return false;
        return true;
      };
      const visible = elements.filter(usable);
      // Solo imágenes que claramente son el captcha. Se EXCLUYE el botón de recargar,
      // logos, banners, etc. (antes se colaba el reloadButton y mandaba basura a 2Captcha).
      const esCaptcha = (el) => {
        const s = `${el.src || ''} ${el.id || ''} ${el.className || ''} ${el.alt || ''}`;
        if (/reload|refresh|logo|header|divider|banner|support|email-text/i.test(s)) return false;
        return /captcha|verif|code from|code/i.test(s) || el.id === 'captcha_image_itself';
      };
      const byName = visible.find(esCaptcha);
      // Solo se usa el id conocido si está cargado y no es el botón de recargar.
      const image = (usable(known) && esCaptcha(known) ? known : null) || byName;
      if (!image) return false;

      image.setAttribute('data-momonga-captcha-image', '1');
      input.setAttribute('data-momonga-captcha-input', '1');
      return true;
    }, CAPTCHA_INPUT_SELECTORS).catch(() => false);
    if (marked) return true;
  }
  return false;
}

// Refresca la imagen del captcha (para cuando no cargó o salió mal).
async function refreshCaptchaImage(page) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const info = (el) => `${el.id || ''} ${el.className || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('onclick') || ''} ${el.getAttribute('href') || ''} ${el.getAttribute('src') || ''}`;
      const all = Array.from(document.querySelectorAll('a, button, img, i, span, div, input[type="button"]')).filter((el) => el.offsetParent !== null);
      // 1) botón de recargar (reloadButton.png / onclick captcha)
      const target = all.find((el) => /reloadbutton|reload|refresh|cambiar captcha|renovar|recargar|captcha.*(new|change)|change.*(code|captcha)/i.test(info(el)));
      if (target) { try { target.click(); return true; } catch (_) {} }
      const img = document.getElementById('captcha_image_itself');
      if (img) { try { img.click(); return true; } catch (_) {} }
      return false;
    }).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

// Cierra el aviso "Captcha warning" (imagen no cargó / código incorrecto) si está presente.
async function closeCaptchaWarning(page) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const t = (document.body ? document.body.innerText : '') || '';
      if (!/captcha warning|captcha.*(invalid|incorrect|wrong|no coincide)/i.test(t)) return false;
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], span, div')).filter((el) => el.offsetParent !== null);
      const close = btns.find((el) => /^(close|cerrar|aceptar|ok|continuar|entendido)$/i.test((el.innerText || el.value || '').trim()));
      if (close) { try { close.click(); return true; } catch (_) {} }
      return false;
    }).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

// Espera (con calma) a que la imagen del captcha aparezca REALMENTE cargada; refresca si no.
async function ensureCaptchaImage(page, controller, intentos = 6) {
  const logCapImg = async (tag) => {
    try {
      const info = await page.evaluate(() => {
        const img = document.querySelector('[data-momonga-captcha-image]');
        if (!img) return null;
        const r = img.getBoundingClientRect();
        return { tag: img.tagName, src: String(img.currentSrc || img.src || img.id || '').slice(-55), nw: img.naturalWidth || 0, nh: img.naturalHeight || 0, w: Math.round(r.width), h: Math.round(r.height) };
      }).catch(() => null);
      fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] capimg(${tag})=${JSON.stringify(info)}\n`);
    } catch (_) {}
  };
  for (let i = 1; i <= intentos; i++) {
    await closeCaptchaWarning(page); // cierra el aviso "Captcha warning" si está
    // Da tiempo a que la imagen cargue (la página a veces la carga tarde).
    await sleep(1500);
    if (await markImageCaptcha(page)) { await logCapImg(`ok${i}`); return true; }
    if (controller && controller.log) controller.log(`⏳ Esperando la imagen del captcha (${i}/${intentos})...`);
    // Alterna: recargar solo el captcha (clic) y recargar TODA la página (a veces solo así carga).
    if (i % 2 === 0) {
      try { await page.reload({ waitUntil: 'networkidle2', timeout: 45000 }); } catch (_) {}
      await closeCaptchaWarning(page);
    } else {
      await refreshCaptchaImage(page);
    }
    for (let j = 0; j < 8; j++) {
      await sleep(500);
      if (await markImageCaptcha(page)) { await logCapImg(`ok${i}.${j}`); return true; }
    }
    await logCapImg(`fallo${i}`);
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

    // OJO: comparamos SIN importar MAYUS/minus y sin espacios (el campo suele
    // poner el codigo en MAYUSCULAS; si lo comparabamos igual, creia que fallo).
    const checkValue = () => handle.evaluate((el, val) => {
      const a = String(el.value || '').trim().toUpperCase().replace(/\s+/g, '');
      const b = String(val || '').trim().toUpperCase().replace(/\s+/g, '');
      return a === b;
    }, code).catch(() => false);

    // 1) Teclado real EN EL PROPIO elemento (sirve aunque este en un iframe).
    try {
      await handle.evaluate((el) => { try { el.scrollIntoView({ block: 'center' }); } catch (_) {} el.focus(); }).catch(() => {});
      await handle.click({ clickCount: 3 }).catch(() => {});
      await handle.press('Backspace').catch(() => {});
      await handle.type(code, { delay: 70 }).catch(() => {});
      await handle.evaluate((el) => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }).catch(() => {});
      await sleep(300);
      if (await checkValue()) return true;
    } catch (_) {
      // seguir con el respaldo
    }

    // 2) Respaldo: setter nativo + eventos (sin 'blur' que podia borrarlo).
    const set = await frame.evaluate((sel, val) => {
      const input = document.querySelector(sel);
      if (!input) return false;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, val); else input.value = val;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, selector, code).catch(() => false);

    if (set) {
      await sleep(300);
      if (await checkValue()) return true;
    }

    // Deja en el log que quedo en el campo (para diagnosticar).
    const quedo = await handle.evaluate((el) => String(el.value || '')).catch(() => '?');
    log(`🧩 Captcha: quería "${code}" ; el campo quedó "${quedo}"`);
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
  const ok = await ensureCaptchaImage(page, controller);
  if (!ok) {
    if (controller && controller.log) controller.log('⚠️ Imagen del captcha no disponible (no cargó).');
    return false;
  }

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
      try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] captchaCode(${attempt.label})=${code}\n`); } catch (_) {}
      const filled = await fillCaptchaInput(page, code, controller);
      if (!filled) {
        throw new Error('2Captcha resolvió el código, pero no se pudo escribir en el campo del captcha.');
      }
      // Pausa "humana" tras resolver el captcha (como si lo leyeras) antes de enviar.
      await humanPause(1200, 3200);
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

  // Marca el perfil de origen como BLOQUEADA (no se re-arranca solo) y solo pausa a las
  // demas la PRIMERA vez; si ya estaba bloqueada, no vuelve a parar todo (asi al "Apelar"
  // de nuevo no detiene a las cuentas que siguen actualizandose).
  const src = sourceId ? controllers.get(sourceId) : null;
  const yaBloqueada = Boolean(src && src.blocked);
  if (src) { src.blocked = true; try { saveState(); } catch (_) {} }
  if (yaBloqueada) { emergencyActive = false; return; }

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
      controller.log('📨 Apelando automáticamente por el formulario de soporte...');
      await appealSupportForm(page, controller).catch(() => {});
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
    if (typeof controller._applyPage === 'function') await controller._applyPage(page);
    await page.bringToFront().catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

const FRAUD_MAX_RISK = 33;

// Chequeo de seguridad: IP+datos (ipinfo), riesgo de IP (proxycheck) y fuga WebRTC.
async function runSafetyCheck(controller) {
  const result = { ok: true, reasons: [], at: Date.now() };
  if (!controller || !controller.cfg || !controller.cfg.proxy || !controller.cfg.proxy.host) { result.skipped = true; return result; }
  if (!controller.browser) { result.ok = false; result.reasons.push('navegador no abierto'); return result; }
  let page;
  try {
    page = await controller.browser.newPage();
    if (typeof controller._applyPage === 'function') await controller._applyPage(page);
    let info = {};
    try {
      await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 30000 });
      info = JSON.parse(await page.evaluate(() => document.body.innerText)) || {};
    } catch (_) {}
    result.ip = info.ip || controller._proxyIp || null;
    result.org = info.org || '';
    result.city = info.city || '';
    result.country = info.country || '';
    result.timezone = info.timezone || '';

    if (result.ip) {
      // scamalytics suele estar bloqueado (Cloudflare): usamos proxycheck.io (score de riesgo).
      try {
        const key = process.env.PROXYCHECK_KEY ? `&key=${encodeURIComponent(process.env.PROXYCHECK_KEY)}` : '';
        await page.goto(`https://proxycheck.io/v2/${result.ip}?risk=1&vpn=1${key}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(1200);
        const data = JSON.parse(await page.evaluate(() => (document.body ? document.body.innerText : '{}')));
        const rec = data && data[result.ip];
        if (rec) {
          result.risk = Number(rec.risk);
          result.ipType = rec.type || '';
          result.isProxy = String(rec.proxy || '').toLowerCase() === 'yes';
        }
      } catch (_) {}
    }

    let cands = [];
    try {
      cands = await page.evaluate(async () => {
        const out = [];
        await new Promise((resolve) => {
          try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) out.push(e.candidate.candidate); };
            pc.createDataChannel('x');
            pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
          } catch (_) {}
          setTimeout(resolve, 6000);
        });
        return out;
      });
    } catch (_) {}
    const publicIps = cands.map((c) => (/typ (srflx|relay)/.test(c) ? (String(c).split(' ')[4] || null) : null)).filter(Boolean);
    result.webrtcIps = publicIps;
    // Tolerante a proxy rotativo: vale la IP guardada o la detectada ahora.
    const allowed = [controller._proxyIp, result.ip].filter(Boolean);
    const leaked = publicIps.filter((ip) => !allowed.includes(ip));
    if (leaked.length) { result.ok = false; result.reasons.push(`fuga WebRTC (${leaked.join(', ')})`); }
  } catch (error) {
    result.reasons.push(error.message);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  if (result.risk != null && result.risk > FRAUD_MAX_RISK) {
    result.ok = false;
    result.reasons.push(`riesgo de IP ${result.risk} (> ${FRAUD_MAX_RISK}, ${result.ipType || '?'})`);
  }
  return result;
}

// Chequeo EXTERNO en las paginas pedidas: browserleaks (IP/fugas),
// ip2location (geo + fraud_score + proxy + tipo movil), scamalytics (fraud score)
// y browserscan (deteccion de bot + score). Se hace en el navegador del perfil
// (con su proxy), así que refleja exactamente lo que ve el sitio.
async function runExternalCheck(controller) {
  const out = { ok: true, at: Date.now(), results: {} };
  if (!controller.browser) { try { await controller.open(); } catch (_) {} await sleep(3000); }
  if (!controller.browser) return { ok: false, error: 'No se pudo abrir el navegador.' };
  let page;
  try {
    page = await controller.browser.newPage();
    if (typeof controller._applyPage === 'function') await controller._applyPage(page);
    const grab = async (url, waitMs) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(waitMs || 9000);
      return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    };
    const one = (re, s) => { const m = String(s || '').match(re); return m ? m[1].trim() : null; };

    // 1) browserleaks /ip -> IP real que ve el sitio
    const bl = await grab('https://browserleaks.com/ip', 9000);
    out.results.browserleaks_ip = {
      ip: one(/Your IP Address\s*([\d.]+)/i, bl) || one(/\b([\d]{1,3}(?:\.[\d]{1,3}){3})\b/, bl),
    };

    const ip = out.results.browserleaks_ip.ip;

    // 2) browserleaks /webrtc -> fuga WebRTC
    const br = await grab('https://browserleaks.com/webrtc', 10000);
    {
      const webrtcIp = one(/(?:Your )?WebRTC IP:?\s*([\d.]+)/i, br) || one(/Public IP Address:?\s*([\d.]+)/i, br);
      // No hay fuga si la IP de WebRTC coincide con la IP del proxy (o si la pagina dice "No Local IP Leak").
      const noLeak = /No Local IP Leak/i.test(br) || (webrtcIp && ip && webrtcIp === ip);
      out.results.webrtc = {
        remote_ip: one(/Remote IP:?\s*([\d.]+)/i, br) || ip,
        webrtc_ip: webrtcIp,
        leak: noLeak ? 'No leak' : (webrtcIp ? `FUGA: WebRTC muestra ${webrtcIp}` : 'Revisar'),
      };
    }

    // 3) ip2location -> geo + fraud_score + is_proxy + tipo de uso (MOB = móvil)
    if (ip) {
      const i2 = await grab(`https://www.ip2location.com/demo/${ip}`, 10000);
      out.results.ip2location = {
        country: one(/"country_name":\s*"([^"]+)"/, i2) || one(/Country\s*\n\s*([^\n\[]+)/i, i2),
        region: one(/"region_name":\s*"([^"]+)"/, i2) || one(/Region\s*\n\s*([A-Za-z .]+)/i, i2),
        city: one(/"city_name":\s*"([^"]+)"/, i2) || one(/City\s*\n\s*([A-Za-z .]+)/i, i2),
        isp: one(/"isp":\s*"([^"]+)"/, i2) || one(/ISP\s*\n\s*([^\n]+)/i, i2),
        usage: one(/"usage_type":\s*"([^"]+)"/, i2) || one(/Usage Type\s*\n\s*\(?([A-Z]+)\)?/i, i2),
        is_proxy: one(/"is_proxy":\s*(true|false)/, i2),
        fraud_score: one(/"fraud_score":\s*(\d+)/, i2),
        timezone: one(/"olson":\s*"([^"]+)"/, i2),
      };
    }

    // 4) scamalytics -> fraud score (puede estar tras Cloudflare)
    if (ip) {
      const sc = await grab(`https://scamalytics.com/ip/${ip}`, 9000);
      out.results.scamalytics = { fraud_score: one(/Fraud Score:?\s*(\d+)/i, sc), blocked: /Just a moment|Cloudflare|Access denied|Forbidden/i.test(sc) && !/Fraud Score/i.test(sc) };
    }

    // 5) browserscan -> deteccion de bot + score
    const bs = await grab('https://www.browserscan.net/', 15000);
    out.results.browserscan = {
      bot: /No Detection/i.test(bs) ? 'No Detection' : (/\bBot Detection:?\s*Yes/i.test(bs) ? 'Yes' : null),
      score: one(/\b(\d{1,3})\s*%/, bs),
    };

    controller.log(`🔎 Chequeo externo: IP ${ip || '?'} · fraud ${out.results.ip2location ? out.results.ip2location.fraud_score : '?'} · bot ${out.results.browserscan.bot || '?'}`);
  } catch (e) {
    out.ok = false; out.error = e.message;
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return out;
}

// Chequeo de DETECCION en las paginas de robots/extensiones: sannysoft, creepjs y
// el detector de extensiones. Devuelve el texto de cada una para inspeccionar.
async function runDetect(controller) {
  const out = { ok: true, at: Date.now(), pages: {} };
  if (!controller.browser) { try { await controller.open(); } catch (_) {} await sleep(3000); }
  if (!controller.browser) return { ok: false, error: 'No se pudo abrir el navegador.' };
  let page;
  try {
    page = await controller.browser.newPage();
    if (typeof controller._applyPage === 'function') await controller._applyPage(page);
    const grab = async (url, waitMs) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(waitMs || 9000);
      return page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    };
    out.pages.sannysoft = (await grab('https://bot.sannysoft.com/', 11000)).slice(0, 2200);
    out.pages.creepjs = (await grab('https://abrahamjuliot.github.io/creepjs/', 15000)).slice(0, 2200);
    out.pages.extension_detector = (await grab('https://z0ccc.github.io/extension-detector/', 9000)).slice(0, 1500);
  } catch (e) {
    out.ok = false; out.error = e.message;
  } finally {
    if (page) await page.close().catch(() => {});
  }
  return out;
}

function reportSafetyCheck(controller, result, { pauseOnFail = true } = {}) {
  try {
    if (!result || result.skipped) return;
    io.emit('safety-check', { id: controller.id, ok: result.ok, result, at: Date.now() });
    if (result.ok) {
      controller.log(`🛡️ Chequeo OK · IP ${result.ip || '?'}${result.risk != null ? ` · riesgo ${result.risk}` : ''}${result.ipType ? ` · ${result.ipType}` : ''}${result.org ? ` · ${result.org}` : ''}`);
    } else {
      const msg = result.reasons.join(' / ') || 'fallo';
      controller.warn(`🛡️ Chequeo FALLÓ: ${msg}. Se pausa el perfil.`);
      notify(`🛡️ Chequeo falló en "${controller.id}": ${msg}`);
      if (pauseOnFail && controller.started) controller.pause();
    }
  } catch (_) {}
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
    if (controller.cfg.autoAppeal !== false) {
      controller.log('📨 Apelando por el formulario de soporte...');
      await appealSupportForm(controller.page, controller).catch(() => {});
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

// Detecta el aviso de rate-limit del sitio: "Too many requests ... Allow one request per 5 seconds".
async function detectRateLimit(page) {
  try {
    if (/too.?many.?request|rate.?limit|one request per/i.test(page.url())) return true;
    return await page.evaluate(() => {
      const t = `${document.body ? document.body.innerText : ''} ${document.title || ''}`;
      return /too many requests|one request per|please wait\s*(a few|\d+)?\s*seconds?|rate limit|espera.*segundos/i.test(t);
    }).catch(() => false);
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

// Clic "trusted" (raton real -> isTrusted=true) y FIABLE: usa elementHandle.click de
// Puppeteer (que hace scroll y clica el elemento via CDP) con un offset/retraso humano.
async function trustedClick(page, target, ...args) {
  let el = null;
  try {
    if (typeof target === 'function') {
      const h = await page.evaluateHandle(target, ...args);
      el = h.asElement();
    } else if (typeof target === 'string') {
      el = await page.$(target);
    }
  } catch (_) { el = null; }
  if (!el) return false;
  try {
    const box = await el.boundingBox().catch(() => null);
    const opts = (box && box.width > 4 && box.height > 4)
      ? {
        offset: { x: box.width * (0.35 + Math.random() * 0.3), y: box.height * (0.35 + Math.random() * 0.3) },
        delay: 30 + Math.floor(Math.random() * 80)
      }
      : undefined;
    await el.click(opts);
    return true;
  } catch (_) {
    // NO reintentar el clic: si el clic navego y luego lanzo error, reintentar
    // pulsaria DOS veces el mismo boton (MegaPersonals lo ve como robot).
    return false;
  } finally {
    try { if (el.dispose) await el.dispose(); } catch (_) {}
  }
}

async function clickBumpButton(page) {
  const findBump = () => {
    const visible = (el) => el && el.offsetParent !== null;
    const byId = document.getElementById('managePublishAd');
    if (visible(byId)) return byId;
    const controls = Array.from(document.querySelectorAll('a, button'));
    return controls.find((e) => visible(e) && /bump\s*to\s*top|bump|boost|subir/i.test(`${e.innerText || ''} ${e.value || ''} ${e.id || ''} ${e.getAttribute('href') || ''}`)) || null;
  };
  // Espera a que el boton aparezca y pulsa UN SOLO clic (sin reintentar al instante).
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const h = await page.evaluateHandle(findBump).catch(() => null);
    const el = h && h.asElement ? h.asElement() : null;
    if (h && h.dispose) await h.dispose().catch(() => {});
    if (el) return await trustedClick(page, findBump);
    await sleep(500);
  }
  return false;
}

// Confirma un bump por varias señales (el sitio no siempre cambia la URL).
async function waitBumpConfirm(page, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const href = await page.evaluate(() => window.location.href).catch(() => '');
    if (href.includes('success_publish') || /\/users\/posts\/list/.test(href)) return true;
    const modalOk = await page.evaluate(() => Boolean(
      document.getElementById('success-ok')
      || Array.from(document.querySelectorAll('button, a, div'))
        .find((el) => el.offsetParent !== null && /^(ok|aceptar|continuar)$/i.test((el.innerText || '').trim()))
    )).catch(() => false);
    if (modalOk) return true;
    await sleep(700);
  }
  return false;
}

async function doBump(page, controller) {
  controller.setCycleStage('publishing', 'Buscando el botón de bump.');
  if (!(await clickBumpButton(page))) return false;

  const confirmed = await waitBumpConfirm(page, 25000);
  if (!confirmed) {
    controller.log('ℹ️ Bump pulsado; no se detectó confirmación en la URL, pero se cuenta igual.');
  }

  controller.log(`🚀 Bump confirmado (${page.url()}).`);
  controller.setCycleStage('completed', 'Bump confirmado.');
  controller.recordBump();

  // Cerrar el modal "Success!" con OK para poder seguir
  if (await dismissOkModal(page)) await sleep(1200);

  // Igual que la extensión: esperar (tiempo humano variable) y volver a la lista de posts.
  await humanPause(1200, 2500);
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

  // 0) Cerrar el modal de éxito ("Sweet! Your Post has been published" / "VIEW POST" / "MY POSTS").
  try {
    await dismissOkModal(page).catch(() => {});
    const cogido = await clickTextControl(page, ['my\\s+posts', 'mis\\s+anuncios'], 3500).catch(() => false);
    if (cogido) {
      controller.log('↩️ Modal de éxito: volviendo a Mis Anuncios...');
      await humanPause(1600, 3200);
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
      return;
    }
  } catch (_) {}

  // 1) Pulsar el botón "My Posts" visible si existe (igual que el flujo de la extensión)
  try {
    const myPostsClicked = await trustedClick(page, () => {
      return Array.from(document.querySelectorAll('a.manage-button, a[href*="users/posts/list"]'))
        .find(a => a.offsetParent !== null && (a.innerText || '').trim().toLowerCase().includes('my posts')) || null;
    });

    if (myPostsClicked) {
      controller.log('↩️ Volviendo a Mis Anuncios (My Posts)...');
      await humanPause(1600, 3200); // tiempo humano variable al volver
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

  if (await detectRateLimit(page)) { controller._rateLimited = true; return false; }

  if (await doBump(page, controller)) return true;

  if (await detectRateLimit(page)) { controller._rateLimited = true; return false; }

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

  const limite = Math.max(0, Math.floor(Number(controller.cfg.postsARotar) || 0));
  const lista = limite >= 1 ? ads.slice(0, Math.min(ads.length, limite)) : ads;
  const currentIds = lista.map((ad) => ad.id);
  const queue = (Array.isArray(controller.rotateQueue) ? controller.rotateQueue : [])
    .filter((id) => currentIds.includes(id));
  for (const id of currentIds) {
    if (!queue.includes(id)) queue.push(id);
  }
  controller.rotateQueue = queue;

  const targetId = queue.shift();
  queue.push(targetId);
  const position = currentIds.indexOf(targetId) + 1;
  const target = lista.find((ad) => ad.id === targetId) || { id: targetId, title: '' };

  controller.log(`🔄 Anuncio ${position}/${lista.length}${limite >= 1 ? ` (rotando ${limite} de ${ads.length})` : ' (todos)'} (ID ${targetId}${target.title ? ` · ${target.title}` : ''}).`);

  const viaSelect = target.href && target.href.indexOf('/users/posts/select/') > -1;
  let clicked = false;

  // El sitio exige "1 peticion cada 5 segundos": espera (variable) antes de abrir el anuncio.
  await humanPause(5500, 8000);

  if (viaSelect) {
    // Ir a la pagina del anuncio y pulsar "Bump to Top" (metodo fiable)
    try {
      await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (error) {
      controller.log(`No se pudo abrir el anuncio ${targetId}: ${error.message}`);
      return false;
    }
    if (await checkForBlock(page, controller)) return false;
    // Respeta el limite del sitio: "Allow one request per 5 seconds" (variable).
    await humanPause(5500, 8000);
    if (await detectRateLimit(page)) {
      controller.warn('⏳ El sitio pidió esperar (rate-limit). Espero 9s y reintento...');
      await sleep(20000);
      try { await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (_) {}
      await humanPause(2000, 3500);
      if (await detectRateLimit(page)) { controller._rateLimited = true; return false; }
    }
    await humanPause(900, 2200); // pausa humana antes de clicar Bump
    clicked = await trustedClick(page, '#managePublishAd');
    if (!clicked && await detectRateLimit(page)) {
      await sleep(20000);
      clicked = await trustedClick(page, '#managePublishAd');
      if (!clicked) { controller._rateLimited = true; return false; }
    }
  } else {
    // Bump directo por enlace (pausa humana antes de clicar)
    await humanPause(900, 2200);
    clicked = await trustedClick(page, `a[href*="/users/posts/bump/${targetId}"]`);
  }

  if (!clicked) {
    controller.log(`❌ No se encontró el botón de bump del anuncio ${targetId}.`);
    return false;
  }

  const confirmed = await waitBumpConfirm(page, 25000);
  if (!confirmed) {
    controller.log(`ℹ️ Bump del anuncio ${targetId} pulsado; no se detectó confirmación, se cuenta igual.`);
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
  return await trustedClick(page, (expectedPatterns) => {
    const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    return controls.find(control => {
      if (control.offsetParent === null || control.id === 'delete-post-id') return false;
      const text = `${control.innerText || ''} ${control.value || ''}`.trim();
      return expectedPatterns.some(pattern => new RegExp(pattern, 'i').test(text));
    }) || null;
  }, patterns);
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

// Escribe un campo con TECLADO REAL (como humano) para no delatar el llenado instantaneo.
// Devuelve true si quedo escrito; si no, el caller usa el setter JS de respaldo.
async function typeLikeHuman(page, value, finder = {}) {
  if (value === undefined || value === null || String(value) === '') return false;
  const str = String(value);
  let handle = null;
  try {
    if (finder.selector) handle = await page.$(finder.selector);
    if (!handle && finder.label) {
      const marked = await page.evaluate((re) => {
        const rx = new RegExp(re, 'i');
        const nodes = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div, legend'));
        for (const el of nodes) {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 40 || !rx.test(t)) continue;
          const scope = el.parentElement || el;
          const f = scope.querySelector('input:not([type="hidden"]), textarea, select');
          if (f && f.offsetParent !== null && !f.disabled && !f.readOnly) { f.setAttribute('data-momonga-fill', '1'); return true; }
        }
        return false;
      }, finder.label).catch(() => false);
      if (marked) handle = await page.$('[data-momonga-fill="1"]');
    }
    if (!handle) return false;
    const tag = await handle.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      await handle.evaluate((n, v) => {
        const w = String(v).trim().toLowerCase();
        const opt = Array.from(n.options).find((o) => (o.textContent || '').trim().toLowerCase() === w) || Array.from(n.options).find((o) => String(o.value) === String(v));
        if (opt) { n.value = opt.value; n.dispatchEvent(new Event('change', { bubbles: true })); }
      }, str).catch(() => {});
    } else {
      await handle.evaluate((n) => { try { n.scrollIntoView({ block: 'center' }); } catch (_) {} n.focus(); }).catch(() => {});
      await handle.click({ clickCount: 3 }).catch(() => {});
      await page.keyboard.down('Control').catch(() => {});
      await page.keyboard.press('KeyA').catch(() => {});
      await page.keyboard.up('Control').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      const delay = 22 + Math.floor(Math.random() * 60); // 22-82 ms por tecla (ritmo humano)
      // Escribir LINEA por linea y pulsar Enter entre ellas, para que se conserve
      // el formato (MegaPersonals corta el texto por lineas; si no, sale todo junto).
      const lineas = str.split('\n');
      for (let li = 0; li < lineas.length; li++) {
        if (lineas[li]) await handle.type(lineas[li], { delay }).catch(() => {});
        if (li < lineas.length - 1) { await handle.press('Enter').catch(() => {}); await sleep(70 + Math.floor(Math.random() * 130)); }
      }
    }
    const got = await handle.evaluate((n) => String(n.value || '')).catch(() => '');
    await handle.evaluate((n) => n.removeAttribute('data-momonga-fill')).catch(() => {});
    const a = got.replace(/\s+/g, ' ').trim().toLowerCase();
    const b = str.replace(/\s+/g, ' ').trim().toLowerCase();
    return a === b && a.length > 0;
  } catch (_) {
    return false;
  }
}

// Llena un campo de texto escribiendo como humano; si falla, cae al setter JS (respaldo).
async function fillText(page, value, finder = {}, controller) {
  if (value === undefined || value === null || String(value) === '') return false;
  if (await typeLikeHuman(page, value, finder)) return true;
  if (finder.selector && await fillExactField(page, finder.selector, value)) return true;
  if (finder.label && await fillFieldByLabel(page, finder.label, value)) return true;
  return false;
}

async function fillPhone(page, value, controller) {
  if (!value) return false;

  const debug = await page.evaluate((val) => {
    const raw = String(val).trim();
    const digits = raw.replace(/\D/g, '');
    const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : raw.replace(/[\s().-]+/g, '');
    const info = { normalized, matched: null, cloned: false, after: null };

    const setVal = (f) => {
      if (!f || !('value' in f)) return false;
      info.matched = f.id || f.name || f.type || f.className;
      if (String(f.value || '').replace(/\D/g, '') === String(normalized).replace(/\D/g, '')) { info.after = f.value; return true; }
      // MegaPersonals BORRA el teléfono con handlers de 'input'/'blur' (bloqueo "1 cambio/día").
      // Clonamos el nodo: eso elimina todos los listeners, así el número queda FIJO en el campo.
      let target = f;
      try {
        const clone = f.cloneNode(true);
        if (f.parentNode) { f.parentNode.replaceChild(clone, f); target = clone; info.cloned = true; }
      } catch (_) { target = f; }
      const setter = Object.getOwnPropertyDescriptor(target.__proto__, 'value')?.set;
      try { if (setter) setter.call(target, normalized); else target.value = normalized; } catch (_) { target.value = normalized; }
      target.dispatchEvent(new Event('change', { bubbles: true }));
      info.after = target.value;
      return String(target.value || '').replace(/\D/g, '').length >= 7;
    };

    // Priorizar SIEMPRE el campo real #phonenumber (hay otro input "phone" oculto que ganaba en querySelector).
    const direct = document.getElementById('phonenumber')
      || document.querySelector('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"], input[name*="cell" i], input[id*="cell" i], input[name*="mobile" i], input[id*="mobile" i]');
    if (setVal(direct)) { info.ok = true; return info; }

    // Si hay un selector de país (+1) junto a un input, ese input es el teléfono.
    const countrySelects = Array.from(document.querySelectorAll('select')).filter((s) =>
      Array.from(s.options).some((o) => /\+1\b/.test(o.textContent || ''))
    );
    for (const s of countrySelects) {
      const wrap = s.parentElement;
      if (!wrap) continue;
      const input = Array.from(wrap.querySelectorAll('input:not([type="hidden"])')).find((i) => i.type !== 'checkbox' && i.type !== 'radio');
      if (setVal(input)) { info.ok = true; return info; }
    }

    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const labels = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'));
    for (const el of labels) {
      const t = clean(el.textContent);
      if (!t || t.length > 30 || !/^\s*phone/i.test(t)) continue;
      const scope = el.parentElement || el;
      const num = Array.from(scope.querySelectorAll('input:not([type="hidden"])')).find((i) => i.type !== 'checkbox');
      if (setVal(num)) { info.ok = true; return info; }
    }
    info.ok = false;
    return info;
  }, value).catch((e) => ({ err: String(e && e.message) }));

  if (controller) controller.log(`📞 debug teléfono: ${JSON.stringify(debug)}`);
  return Boolean(debug && debug.ok);
}

// Selecciona las categorías obligatorias "I AM" / "I SEE" (si no, el sitio rechaza el anuncio).
async function selectIamAndIsee(page, details = {}) {
  const iamForzado = String(details.iam || '').trim();
  const iseeForzado = Array.isArray(details.isee) ? details.isee.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const iam = iamForzado || 'A woman';
  const isee = iseeForzado.length ? iseeForzado : ['Men'];
  return page.evaluate((iamWanted, iseeWanted, forceIam, forceIsee) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const norm = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const fire = (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const optionMatch = (opt, wanted) => {
      const w = norm(wanted);
      return norm(opt.value) === w || norm(opt.textContent) === w || norm(opt.textContent).includes(w);
    };

    const labels = Array.from(document.querySelectorAll('label, b, strong, span, td, th, p, div'))
      .filter((el) => { const t = clean(el.textContent); return t && t.length <= 30; });
    const scopeFor = (el) => {
      if (el.htmlFor) { const f = document.getElementById(el.htmlFor); if (f) return f; }
      let f = el.querySelector('select, input, textarea');
      if (f) return f;
      let sib = el.nextElementSibling;
      while (sib) { f = sib.matches('select, input, textarea') ? sib : sib.querySelector('select, input, textarea'); if (f) return f; sib = sib.nextElementSibling; }
      const parent = el.parentElement;
      if (parent) { f = parent.querySelector('select, input, textarea'); if (f) return f; }
      return null;
    };

    let iamDone = false;
    const iamLabel = labels.find((el) => /^i\s*am/i.test(clean(el.textContent)));
    if (iamLabel) {
      const sel = scopeFor(iamLabel) || (iamLabel.parentElement && iamLabel.parentElement.querySelector('select'));
      const select = sel && sel.tagName === 'SELECT' ? sel : (sel && sel.closest && sel.closest('select'));
      if (select && (forceIam || !select.value || /^$|^select$/i.test(norm(select.options[select.selectedIndex] ? select.options[select.selectedIndex].textContent : '')))) {
        const opt = Array.from(select.options).find((o) => optionMatch(o, iamWanted)) || Array.from(select.options).find((o) => o.value && !/select|^\s*$/i.test(o.textContent));
        if (opt) { select.value = opt.value; fire(select); iamDone = true; }
      }
    }

    // I SEE en MegaPersonals es un multiselect jQuery (#iseeCategories_multiSelect):
    // hay que clicar el CHECKBOX REAL del widget; marcar la <select> oculta no basta.
    let iseeDone = false;
    const iseeWidget = document.getElementById('iseeCategories_multiSelect');
    const nativeIsee = document.getElementById('iseeCategories');
    const queridosIsee = iseeWanted.length ? iseeWanted : ['Men'];
    if (iseeWidget) {
      const boxes = Array.from(iseeWidget.querySelectorAll('input.multiselect-checkbox'));
      const matchBox = (wanted) => {
        const w = norm(wanted);
        return boxes.find((b) => {
          const val = norm(b.getAttribute('data-val') || '');
          const txt = norm(b.closest('label') ? b.closest('label').textContent : '');
          return (val && val === w) || (txt && txt === w) || (val && w && (val.includes(w) || w.includes(val))) || (txt && w && (txt.includes(w) || w.includes(txt)));
        });
      };
      for (const wanted of queridosIsee) {
        const box = matchBox(wanted);
        if (box) { if (!box.checked) box.click(); iseeDone = true; }
      }
      if (!iseeDone) {
        const first = boxes.find((b) => (b.getAttribute('data-val') || '') !== '-1' && !b.disabled);
        if (first) { if (!first.checked) first.click(); iseeDone = true; }
      }
      if (nativeIsee) {
        for (const wanted of queridosIsee) {
          const opt = Array.from(nativeIsee.options).find((o) => optionMatch(o, wanted));
          if (opt) opt.selected = true;
        }
        fire(nativeIsee);
      }
    } else {
      const iseeLabel = labels.find((el) => /^i\s*see/i.test(clean(el.textContent)));
      if (iseeLabel) {
      const scope = iseeLabel.parentElement || iseeLabel;
      const multi = scope.querySelector('select') || (iseeLabel.nextElementSibling && iseeLabel.nextElementSibling.querySelector && iseeLabel.nextElementSibling.querySelector('select'));
      const select = multi && multi.tagName === 'SELECT' ? multi : (multi && multi.closest ? multi.closest('select') : null);
      if (select && select.multiple) {
        const yaHay = Array.from(select.options).some((o) => o.selected);
        if (forceIsee || !yaHay) {
          for (const wanted of iseeWanted) {
            const opt = Array.from(select.options).find((o) => optionMatch(o, wanted));
            if (opt) { opt.selected = true; iseeDone = true; }
          }
          if (!iseeDone && select.options.length) { select.options[0].selected = true; iseeDone = true; }
          if (iseeDone) fire(select);
        }
      } else if (select) {
        const cur = select.options[select.selectedIndex];
        if (forceIsee || !select.value || /^$|^select$/i.test(norm(cur ? cur.textContent : ''))) {
          const opt = Array.from(select.options).find((o) => optionMatch(o, iseeWanted[0])) || Array.from(select.options).find((o) => o.value && !/select|^\s*$/i.test(o.textContent));
          if (opt) { select.value = opt.value; fire(select); iseeDone = true; }
        }
      } else {
        const boxes = Array.from(scope.querySelectorAll('input[type="checkbox"]'));
        if (boxes.length && (forceIsee || !boxes.some((b) => b.checked))) {
          for (const b of boxes) {
            const t = norm(b.closest('label') ? b.closest('label').textContent : (b.parentElement ? b.parentElement.textContent : ''));
            if (iseeWanted.some((w) => norm(w) && t.includes(norm(w)))) { if (!b.checked) b.click(); iseeDone = true; }
          }
          if (!iseeDone && boxes[0] && !boxes[0].checked) { boxes[0].click(); iseeDone = true; }
        }
      }
      }
    }

    return { iamDone, iseeDone };
  }, iam, isee, Boolean(iamForzado), iseeForzado.length > 0).catch(() => ({ iamDone: false, iseeDone: false }));
}

// Detecta el aviso "You can only change your phone number once per day" y pulsa OK.
async function dismissPhoneLimitPopup(page) {
  return page.evaluate(() => {
    const text = (document.body && document.body.innerText) || '';
    if (!/once per day|come back tomorrow|only change your phone/i.test(text)) return false;
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], span, div'))
      .filter((el) => el.offsetParent !== null);
    const ok = btns.find((el) => /^(ok|okay|aceptar|continuar|close|cerrar)$/i.test((el.innerText || el.value || '').trim()));
    if (ok) { try { ok.click(); } catch (_) {} }
    return true;
  }).catch(() => false);
}

// Detecta errores de validación del formulario (categorías/teléfono) que impiden avanzar.
async function detectFormValidationError(page) {
  return page.evaluate(() => {
    const text = (document.body && document.body.innerText) || '';
    return /category not selected|at least 1 category|is required|required field|not selected|please select/i.test(text);
  }).catch(() => false);
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

  // En MegaPersonals las ciudades son <a data-short-name="NC"> dentro del popup.
  // Varias ciudades comparten nombre (p.ej. "Wilmington" existe en Delaware y en
  // North Carolina), asi que elegimos la que coincide EXACTAMENTE con el codigo de
  // estado del cliente (data-short-name). Si no, se escogia el estado equivocado.
  const clickedCityAnchor = await page.evaluate(({ city, code }) => {
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const target = norm(city);
    const wanted = norm(code);
    const anchors = Array.from(document.querySelectorAll('.ac-sub-text p a, article.ac-sub-text a'));
    if (!anchors.length) return false;
    let lista = anchors.filter((a) => norm(a.textContent) === target);
    if (!lista.length) lista = anchors.filter((a) => norm(a.textContent).includes(target) && target);
    if (wanted) {
      const conEstado = lista.filter((a) => norm(a.getAttribute('data-short-name')) === wanted);
      if (conEstado.length) lista = conEstado;
    }
    const elegido = lista[0];
    if (!elegido) return false;
    elegido.click();
    return true;
  }, { city: cityName, code: stateCode }).catch(() => false);

  if (clickedCityAnchor) {
    const verificado = await page.waitForFunction((wantedValue) => {
      const f = document.querySelector('#cityName');
      const w = String(wantedValue || '').trim().toLowerCase();
      const v = f ? String(f.value || '').trim().toLowerCase() : '';
      return Boolean(f) && (v === w || (w && v.includes(w.split(',')[0].trim())));
    }, { timeout: 4000 }, value).catch(() => false);
    if (verificado) {
      controller.log(`📍 Ciudad seleccionada: ${value}.`);
      return true;
    }
    controller.log(`⚠️ Se hizo clic en "${cityName}" pero el campo no quedo en "${value}"; reintentando por el metodo anterior.`);
  }

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
  const directClicked = await trustedClick(page, () => {
    const button = document.querySelector('#next_button_from_first_form_page');
    if (!button || button.offsetParent === null) return null;
    return button;
  });
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
    controller.lastError = 'CAPTCHA no resuelto (se agotó el tiempo de espera manual).';
    notify(`❌ No se pudo publicar/editar "${controller.id}": el CAPTCHA no se resolvió (imagen no cargó o no se introdujo a tiempo).`).catch(() => {});
  }
  return solved;
}

// Popup de ciudad de pago: hay que confirmarlo para que se envíe el formulario
async function confirmTokenPopup(page) {
  const ready = await page.evaluate(() => {
    const popup = document.getElementById('confirmModal_enoughTokens');
    return Boolean(popup && popup.offsetParent !== null && getComputedStyle(popup).display !== 'none');
  }).catch(() => false);
  if (!ready) return false;
  return await trustedClick(page, () => {
    const popup = document.getElementById('confirmModal_enoughTokens');
    if (!popup) return null;
    return document.getElementById('createBumpPostUrl')
      || Array.from(popup.querySelectorAll('.flex-btn div, button, a'))
        .find((el) => el.offsetParent !== null && /ok|accept|continue|confirm|publish|post/i.test(`${el.innerText || ''} ${el.id || ''}`)) || null;
  });
}

// Modal "Success!" con botón OK (success_publish / imágenes revisadas): hay que cerrarlo para seguir
async function dismissOkModal(page) {
  return await trustedClick(page, () => {
    const byId = document.getElementById('success-ok');
    if (byId && byId.offsetParent !== null) return byId;
    const byImg = Array.from(document.querySelectorAll('img')).find((el) => el.offsetParent !== null && /buttonok/i.test(el.getAttribute('src') || ''));
    if (byImg) return byImg;
    const byText = Array.from(document.querySelectorAll('button, a, input[type="button"], div'))
      .find((el) => el.offsetParent !== null && /^ok$/i.test((el.innerText || el.value || '').trim()));
    return byText || null;
  });
}

// Página de imágenes pendientes (/users/pendingImages/...): hay que pulsar el botón OK
async function clickPendingImagesOk(page) {
  return await trustedClick(page, () => {
    const byId = document.getElementById('success-ok');
    if (byId && byId.offsetParent !== null) return byId;
    const byAttr = Array.from(document.querySelectorAll('img, button, a, div, input'))
      .find((el) => el.offsetParent !== null && /buttonok|success-ok|ok\.png/i.test(`${el.id || ''} ${el.getAttribute('src') || ''}`));
    if (byAttr) return byAttr;
    // Fallback: cualquier botón/enlace/imagen de OK visible (el sitio cambio el boton).
    const candidatos = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], img'));
    return candidatos.find((el) => {
      if (el.offsetParent === null) return false;
      if (el.disabled) return false;
      const t = `${el.innerText || ''} ${el.value || ''} ${el.id || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''}`.trim();
      return /^(ok|okay|continue|accept|aceptar|continuar|done|listo|cerrar|close)$/i.test(t)
        || /\b(ok|okay|continue|aceptar|continuar)\b/i.test(t);
    }) || null;
  });
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

      const deleteClicked = await trustedClick(page, () => {
        const knownButton = document.querySelector('#delete-post-id');
        if (knownButton && knownButton.offsetParent !== null) return knownButton;
        return Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
          .find((el) => el.offsetParent !== null && /delete|remove|borrar|eliminar/i.test(`${el.innerText || ''} ${el.value || ''}`)) || null;
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
    await humanPause(500, 1200);
    await selectIamAndIsee(page, details);
    await humanPause(600, 1500);
    /* Nombre/Alias del anuncio: NO se llena (se deja vacio) */
    await humanPause(700, 1800);
    await fillText(page, headlineToUse, { label: '^\\s*headline' });
    await humanPause(800, 2000);
    await fillExactField(page, '#age', details.age) || await fillFieldByLabel(page, '^\\s*age', details.age);
    await humanPause(1200, 2800);
    await fillText(page, textToUse, { selector: '#body', label: '^\\s*body' });
    await humanPause(700, 1700);
    controller.setCycleStage('city', `Seleccionando ciudad: ${details.city}.`);
    if (!(await selectCity(page, details.city, controller))) return false;
    await humanPause(700, 1600);
    const locationFilled = await fillText(page, details.location, { selector: '#location', label: '^\\s*location' });
    if (details.location && !locationFilled) {
      controller.setCycleStage('error', `No se pudo escribir la ubicación: ${details.location}.`);
      controller.log(`❌ No se pudo llenar Location/Area con "${details.location}".`);
      return false;
    }
    if (locationFilled) controller.log(`📍 Location/Area escrito: ${details.location}.`);
    await humanPause(600, 1400);
    await fillPhone(page, details.phone, controller);
    const telAfter = await page.evaluate(() => (document.getElementById('phonenumber') || {}).value).catch(() => '(err)');
    controller.log(`📞 Teléfono: quería "${details.phone}" ; el campo quedó "${telAfter}"`);
    if (await dismissPhoneLimitPopup(page)) {
      controller.log('⚠️ El sitio NO permitió cambiar el teléfono (solo 1 cambio por día).');
      controller.lastError = 'El sitio no permitió cambiar el teléfono (solo 1 cambio por día).';
      notify(`⚠️ No se pudo cambiar el teléfono en "${controller.id}": MegaPersonals solo permite 1 cambio por día.`).catch(() => {});
    }
    await humanPause(1200, 2600);

    if (!(await clickNextStep(page, controller))) return false;

    await sleep(1500);
    if (await detectFormValidationError(page)) {
      const mensaje = 'El formulario rechazó el anuncio (I AM / I SEE / teléfono).';
      controller.setCycleStage('error', mensaje);
      controller.log(`❌ ${mensaje}`);
      notify(`❌ REPOST incompleto en "${controller.id}": ${mensaje}`);
      return false;
    }

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
        published = await trustedClick(page, () => {
          // Botón real de MegaPersonals: <div id="input_send" class="myButton previewbutton"> (sin texto)
          const direct = document.getElementById('input_send')
            || document.querySelector('.myButton.previewbutton');
          if (direct && direct.offsetParent !== null) return direct;
          const form = document.querySelector('form');
          const submit = form && form.querySelector('button[type="submit"], input[type="submit"]');
          if (submit && submit.offsetParent !== null && !submit.disabled) return submit;
          return Array.from(document.querySelectorAll('button, input[type="submit"], a'))
            .find((el) => el.offsetParent !== null && !el.disabled && /publish|post\s*ad|submit|publicar|send/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''}`)) || null;
        });
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
    controller.lastPhotoHash = hashPhotoSet((controller.cfg.adDetails || {}).photosPath);
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

// Aplica los cambios del anuncio en la cuenta real:
//  - Si hay un post: pulsa "Edit Post" y guarda (no borra).
//  - Si NO hay post (ya borrado) o ya estamos en /users/posts/create: crea/publica el anuncio.
// Remueve el anuncio actual (solo borra; NO crea nada). Para cuentas con 2 anuncios
// o cuando quieres quitar la publicacion y luego hacer una nueva.
async function removePost(page, controller) {
  const urls = siteUrls(controller);
  controller.setCycleStage('removing', 'Abriendo Manage Posts para remover.');
  controller.log('🗑️ Removiendo el anuncio...');
  try {
    await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    controller.log(`No se pudo abrir Mis Anuncios: ${e.message}`);
    return false;
  }
  if (await ensureSession(page, controller)) {
    await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  }
  if (await checkForBlock(page, controller)) return false;

  const clicked = await trustedClick(page, () => {
    const knownButton = document.querySelector('#delete-post-id');
    if (knownButton && knownButton.offsetParent !== null) return knownButton;
    return Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
      .find((el) => el.offsetParent !== null && /remove\s*post|delete\s*post|remove|delete|borrar|eliminar/i.test(`${el.innerText || ''} ${el.value || ''}`)) || null;
  });
  if (!clicked) {
    controller.log('ℹ️ No se encontró el botón de remover (quizá ya no hay anuncio).');
    controller.setCycleStage('error', 'No se encontró el botón Remover.');
    return false;
  }

  await sleep(3000);
  await page.waitForFunction(() => {
    const controls = Array.from(document.querySelectorAll('button, a, input[type="submit"]'));
    return controls.some(c => /confirm|yes|sí|si|delete|borrar/i.test(`${c.innerText || ''} ${c.value || ''}`));
  }, { timeout: 5000 }).then(() => clickTextControl(page, ['confirm', '^yes$', '^sí$', '^si$', 'delete', 'remove', 'borrar'], 3000)).catch(() => {});
  await sleep(1500);

  if (await detectRateLimit(page)) { controller._rateLimited = true; return false; }
  await dismissOkModal(page).catch(() => {});
  controller.log('✅ Anuncio removido (solo remoción, sin crear).');
  controller.setCycleStage('completed', 'Anuncio removido.');
  notify(`🗑️ Anuncio removido en "${controller.id}".`);
  return true;
}

// Genera un texto de apelacion distinto cada vez, con la hora en que se bloqueo.
function appealDetail(controller) {
  let hora = '';
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(APPEALS_DIR, 'index.json'), 'utf8'));
    const rec = (Array.isArray(idx) ? idx : []).slice().reverse().find((r) => r.profile === controller.id);
    if (rec && rec.at) hora = new Date(rec.at).toLocaleString('en-US', { timeZone: 'America/New_York' });
  } catch (_) {}
  if (!hora) hora = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const abridor = [
    'Hello', 'Hi', 'Good day', 'Greetings', 'Hi there', 'Hello team',
  ];
  const cuerpo = [
    'I think my account was blocked by mistake.',
    'I believe my account has been blocked in error.',
    'My account appears to have been suspended by accident.',
    'I think my ad was blocked by mistake.',
  ];
  const extra = [
    'I am a real person and I always follow your rules.',
    'I only use megapersonals.eu and I never used any scam site.',
    'I never used a scam site; I only post here on megapersonals.eu.',
    'I have always used only the real site and I never shared my password with anyone.',
    'I did not click any suspicious link and I only log in here on megapersonals.eu.',
  ];
  const cierre = [
    'Please review my account and reactivate it. Thank you very much.',
    'Please check my account and turn it back on. Thanks in advance.',
    'I would really appreciate it if you could review and reactivate my account. Thank you.',
    'Kindly review my account and reactivate it. Thank you for your time.',
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const txt = `${pick(abridor)}, ${pick(cuerpo)} It was blocked on ${hora}. ${pick(extra)} ${pick(cierre)}`;
  return txt.slice(0, 512);
}

// Texto de apelacion para el formulario CONTACT US (varias versiones al azar).
// Enfocado en pedir ayuda para REGISTRARSE / completar la verificacion.
function contactoApelacion() {
  const hora = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const subjects = [
    'Need help to complete my registration',
    'Cannot finish my verification',
    'Help please - cannot complete sign up',
    'Unable to complete my registration',
    'Need help verifying my account',
    'Help finishing my registration',
  ];
  const abridor = ['Hello team', 'Hi', 'Good day', 'Hello', 'Greetings'];
  const cuerpo = [
    'I am trying to register on megapersonals.eu but I cannot complete the verification.',
    'I cannot finish the sign up process; the verification does not go through.',
    'I am trying to create my account but the registration does not complete.',
    'I cannot complete my verification in order to finish registering.',
    'My registration gets stuck and I cannot verify my account.',
  ];
  const extra = [
    'I am a real person and I want to post on your site.',
    'I only want to use megapersonals.eu.',
    'I never used any other site.',
  ];
  const cierre = [
    'Could you please help me complete my registration? Thank you.',
    'I would appreciate your help to finish it. Thanks.',
    'Please help me get registered. Thank you very much.',
    'Kindly help me complete the verification. Thanks.',
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return {
    subject: pick(subjects),
    message: `${pick(abridor)}, ${pick(cuerpo)} I have been trying since ${hora}. ${pick(extra)} ${pick(cierre)}`.slice(0, 512),
  };
}

// Navegadores dedicados por CORREO (Outlook) para ver la bandeja desde el panel.
const mailBrowsers = new Map();
const mailIdDe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@._-]/g, '_').slice(0, 80) || 'correo';

async function openMailBrowser(id, url) {
  const key = mailIdDe(id);
  const ya = mailBrowsers.get(key);
  if (ya && ya.browser && ya.browser.connected) {
    try { const ps = await ya.browser.pages(); if (ps[0]) await ps[0].bringToFront(); } catch (_) {}
    return { ok: true, abierto: true, ya: true };
  }
  const dir = path.join(__dirname, 'profiles', '_correos', key);
  fs.mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: detectChromeExecutable(),
    ignoreDefaultArgs: ['--enable-automation'],
    userDataDir: dir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    defaultViewport: null,
  });
  mailBrowsers.set(key, { browser, email: String(id) });
  browser.on('disconnected', () => { const m = mailBrowsers.get(key); if (m && m.browser === browser) mailBrowsers.delete(key); });
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  const destino = String(url || '').trim() || 'https://outlook.live.com/mail/0/';
  await page.goto(destino, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  return { ok: true, abierto: true };
}

async function closeMailBrowser(id) {
  const key = mailIdDe(id);
  const m = mailBrowsers.get(key);
  if (m && m.browser) { try { await m.browser.close(); } catch (_) {} }
  mailBrowsers.delete(key);
  return { ok: true };
}

// Cuenta de no leidos leyendo las carpetas del DOM de Outlook. La version nueva
// ya NO pone el conteo en el titulo de la pestana, pero cada carpeta (treeitem)
// trae un title="Bandeja de entrada : Elementos 9 (0 no leidos)". Sumamos todas
// las carpetas (Bandeja de entrada, Correo no deseado, etc.) sin duplicar.
async function unreadCountInPage(page) {
  try {
    return await page.evaluate(() => {
      const parse = (t) => {
        const m = String(t || '').match(/\((\d+)\s*(?:no\s*le[íi]dos?|unread)/i);
        return m ? Number(m[1]) : 0;
      };
      const vistos = new Set();
      let total = 0;
      const leer = (el) => {
        const t = el.getAttribute('title') || '';
        if (!/no\s*le[íi]dos?|unread/i.test(t)) return;
        if (vistos.has(t)) return;
        vistos.add(t);
        total += parse(t);
      };
      for (const el of document.querySelectorAll('[role="treeitem"]')) leer(el);
      if (!vistos.size) for (const el of document.querySelectorAll('[title]')) leer(el);
      return total;
    });
  } catch (_) { return null; }
}

// Estado de los correos abiertos: titulo de la pestana + conteo real de no leidos.
async function mailStatus() {
  const out = [];
  for (const [id, m] of mailBrowsers.entries()) {
    let title = '', url = '', count = null;
    try {
      const ps = await m.browser.pages();
      const p = ps.find((x) => /outlook|live\.com|office/i.test(x.url())) || ps[0];
      if (p) { title = await p.title().catch(() => ''); url = p.url(); count = await unreadCountInPage(p); }
    } catch (_) {}
    out.push({ id, email: m.email || id, title, url, count });
  }
  return { ok: true, mails: out };
}

// Apelacion por el formulario CONTACT US en un navegador LIMPIO (sin sesion): solo el correo.
// Resuelve Cloudflare Turnstile con 2Captcha y lo inyecta en la página.
async function solveTurnstile(apiKey, sitekey, pageUrl, log) {
  const L = (m) => { try { if (log) log(m); } catch (_) {} };
  const inRes = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/in.php?key=${apiKey}&method=turnstile&sitekey=${encodeURIComponent(sitekey)}&pageurl=${encodeURIComponent(pageUrl)}&json=1`).then((r) => r.json());
  if (inRes.status !== 1) throw new Error(inRes.request || 'no se pudo crear la tarea Turnstile');
  const id = inRes.request;
  L(`⏳ Turnstile: tarea 2Captcha ${id}, esperando token...`);
  const start = Date.now();
  while (Date.now() - start < 120000) {
    await sleep(5000);
    const res = await twoCaptchaFetch(`${TWOCAPTCHA_BASE}/res.php?key=${apiKey}&action=get&id=${id}&json=1`).then((r) => r.json());
    if (res.status === 1) return String(res.request || '').trim();
    if (res.request !== 'CAPCHA_NOT_READY') throw new Error(res.request || 'error 2Captcha Turnstile');
  }
  throw new Error('timeout resolviendo Turnstile');
}

// Pasa la verificación Cloudflare Turnstile: intenta clic y, si no pasa, usa 2Captcha.
async function passCloudflare(page, log, apiKey) {
  const L = (m) => { try { if (log) log(m); } catch (_) {} };
  const getState = () => page.evaluate(() => {
    const body = (document.body ? document.body.innerText : '') || '';
    const title = document.title || '';
    const hayForm = !!document.querySelector('#person_username_field_login, #message_contact_us_field');
    const turnstile = !!(document.querySelector('.cf-turnstile, [data-sitekey]')
      || document.querySelector('input[name^="cf-turnstile-response"]')
      || document.querySelector('iframe[src*="challenges.cloudflare.com"]'));
    return { body, title, hayForm, turnstile };
  }).catch(() => ({ body: '', title: '', hayForm: false, turnstile: false }));
  const enDesafio = (st) => !st.hayForm && (st.turnstile || /just a moment|verify you are human|performing security verification|attention required|checking your browser|un momento/i.test(`${st.body} ${st.title}`));

  const url = page.url();
  // 1) Renavegar y clicar: al reintentar la navegación, Cloudflare suele pasar solo (cf_clearance).
  for (let i = 0; i < 4; i++) {
    const st = await getState();
    if (!enDesafio(st)) return true;
    L(`⏳ Cloudflare (${st.title || 'sin titulo'}) — reintentando navegación ${i + 1}/4...`);
    try {
      const frames = page.frames().filter((f) => /challenges\.cloudflare\.com|turnstile/i.test(f.url()));
      for (const fr of frames) {
        const el = await fr.$('input[type="checkbox"], .ctp-checkbox-label, label, body').catch(() => null);
        if (!el) continue;
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width > 4 && box.height > 4) {
          await page.mouse.click(box.x + Math.min(30, box.width / 2), box.y + Math.min(box.height / 2, 22)).catch(() => {});
          break;
        }
      }
    } catch (_) {}
    await sleep(2500);
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (_) {}
    await sleep(4000);
  }

  let st = await getState();
  if (!enDesafio(st)) return true;

  // 2) Fallback: 2Captcha Turnstile.
  if (apiKey) {
    try {
      const sitekey = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile, [data-sitekey]');
        return el ? String(el.getAttribute('data-sitekey') || '') : '';
      }).catch(() => '');
      if (sitekey) {
        L(`🤖 Cloudflare Turnstile: sitekey ${sitekey.slice(0, 18)}…`);
        const token = await solveTurnstile(apiKey, sitekey, page.url(), L);
        await page.evaluate((tk) => {
          for (const sel of ['input[name="cf-turnstile-response"]', 'textarea[name="cf-turnstile-response"]', 'input[name^="cf-turnstile-response"]']) {
            document.querySelectorAll(sel).forEach((el) => {
              try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, tk); } catch (_) { el.value = tk; }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            });
          }
          const cw = document.querySelector('.cf-turnstile');
          const cb = cw && cw.getAttribute('data-callback');
          if (cb && typeof window[cb] === 'function') { try { window[cb](tk); } catch (_) {} }
        }, token).catch(() => {});
        L('✅ Turnstile: token inyectado.');
        for (let i = 0; i < 14; i++) { await sleep(2500); st = await getState(); if (!enDesafio(st)) return true; }
      } else {
        L('⚠️ Cloudflare: no encontré el sitekey para 2Captcha.');
      }
    } catch (e) { L('⚠️ Cloudflare 2Captcha falló: ' + e.message); }
  }
  return false;
}

async function appealContactUsOnce(email, apiKey, proxy) {
  if (!email) return { ok: false, error: 'Falta el email.' };
  let browser = null;
  let bridge = null;
  let keepOpen = false;
  try {
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
    if (proxy && proxy.host) {
      if (proxy.type === 'socks5' && proxy.username) {
        // Chrome no soporta SOCKS5 con usuario/clave: levantamos un puente local.
        try { bridge = await startSocksBridge(proxy); args.push(`--proxy-server=http://127.0.0.1:${bridge.address().port}`); } catch (_) {}
      } else {
        const scheme = proxy.type === 'socks5' ? 'socks5' : 'http';
        args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`);
      }
    }
    browser = await puppeteer.launch({
      headless: false,
      executablePath: detectChromeExecutable(),
      ignoreDefaultArgs: ['--enable-automation'],
      args,
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    // La apelación usa navegador de ESCRITORIO (pasa Cloudflare mejor que el móvil).
    await page.evaluateOnNewDocument(() => {
      // NO parcheamos navigator.webdriver por JS (es detectable por los scanners).
      // Se limpia nativamente con --disable-blink-features=AutomationControlled y
      // quitando --enable-automation (asi el navegador no queda "marcado").
      try {
        const orig = navigator.permissions && navigator.permissions.query;
        if (orig) navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig.call(navigator.permissions, p));
      } catch (_) {}
    }).catch(() => {});
    if (proxy && proxy.host && proxy.username && proxy.type !== 'socks5') {
      try { await page.authenticate({ username: String(proxy.username), password: String(proxy.password || '') }); } catch (_) {}
    }
    await page.goto('https://megapersonals.eu/public/contact_us', { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Pasa la verificación Cloudflare ("Verify you are human") si aparece.
    const logCF = (m) => { try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: ${m}\n`); } catch (_) {} };
    await passCloudflare(page, logCF, apiKey);
    // Espera a que el formulario esté listo.
    try { await page.waitForSelector('#person_username_field_login, input[name="email"]', { timeout: 30000 }); } catch (_) {}
    await sleep(2500);
    try {
      const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        fields: Array.from(document.querySelectorAll('input,textarea,select')).map((i) => ({ tag: i.tagName, type: i.type, name: i.name, ph: i.placeholder, id: i.id })),
      })).catch(() => null);
      fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: ${JSON.stringify(info)}\n`);
    } catch (_) {}
    const { subject, message } = contactoApelacion();

    // Espera a que el formulario esté COMPLETO y rellena; si la página cargó a medias, recarga e intenta de nuevo.
    let check = { email: '', msg: '' };
    for (let f = 1; f <= 3; f++) {
      await page.waitForSelector('#person_username_field_login, input[name="email"]', { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('#message_contact_us_field, textarea[name="message"]', { timeout: 15000 }).catch(() => {});
      await sleep(1200);
      await page.evaluate((em, sub, msg) => {
        const set = (el, v) => {
          if (!el) return false;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); } catch (_) { el.value = v; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        const emailEl = document.getElementById('person_username_field_login') || document.querySelector('input[name="email"]');
        const subjEl = document.getElementById('subject_id') || document.querySelector('input[name="subject"]');
        const msgEl = document.getElementById('message_contact_us_field') || document.querySelector('textarea[name="message"]');
        set(emailEl, em); set(subjEl, sub); set(msgEl, msg);
      }, email, subject, message).catch(() => {});
      await sleep(1200);
      check = await page.evaluate(() => {
        const emailEl = document.getElementById('person_username_field_login') || document.querySelector('input[name="email"]');
        const ta = document.getElementById('message_contact_us_field') || document.querySelector('textarea[name="message"]');
        return { email: emailEl ? String(emailEl.value || '').trim() : '', msg: ta ? String(ta.value || '').trim() : '' };
      }).catch(() => ({ email: '', msg: '' }));
      try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: fill ${f} email=${check.email.slice(0, 40)} msgLen=${check.msg.length}\n`); } catch (_) {}
      if (check.email && check.msg) break;
      if (f < 3) { try { await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }); } catch (_) {} await sleep(3000); }
    }
    if (!check.email || !check.msg) {
      keepOpen = true;
      return { ok: false, error: 'No se pudieron rellenar los campos (email/mensaje) tras varios intentos. Dejo el navegador abierto.', keepOpen: true };
    }

    const fake = {
      log: (m) => { try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: cap ${m}\n`); } catch (_) {} },
      warn: () => {}, setCycleStage: () => {}, cycleStage: '', cfg: {},
    };

    let confirmado = false;
    let errorCaptcha = false;
    const MAX_CAP = 4;
    for (let intento = 1; intento <= MAX_CAP && !confirmado; intento++) {
      // En reintento: limpia el captcha anterior para volver a resolverlo.
      if (intento > 1) {
        await page.evaluate(() => {
          const i = document.querySelector('input[placeholder*="picture" i], #captcha_code, input[name*="captcha" i]');
          if (i) { try { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); } catch (_) { i.value = ''; } i.dispatchEvent(new Event('input', { bubbles: true })); }
        }).catch(() => {});
        await closeCaptchaWarning(page); // cierra el aviso si quedó abierto
        await refreshCaptchaImage(page); // captcha nuevo para el reintento
        await sleep(1800);
      }
      if (apiKey) {
        for (let i = 0; i < 15; i++) { if (await markImageCaptcha(page)) break; await sleep(1000); }
        await sleep(800);
        try { await solveImageCaptcha(apiKey, page, fake); } catch (e) { try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: cap ERR ${e.message}\n`); } catch (_) {} }
      }
      await sleep(1500);
      const captchaLleno = await page.evaluate(() => {
        const i = document.querySelector('input[placeholder*="picture" i], #captcha_code, input[name*="captcha" i]');
        return i ? String(i.value || '').trim().length > 0 : false;
      }).catch(() => false);
      if (!captchaLleno) { errorCaptcha = true; continue; }

      const enviado = await clickTextControl(page, ['send\\s+message', 'send', 'enviar'], 8000);
      await sleep(5000);
      if (!enviado) { keepOpen = true; return { ok: false, error: 'No encontré el botón "Send Message". Dejo el navegador abierto.', keepOpen: true }; }

      const st = await page.evaluate(() => {
        const t = (document.body ? document.body.innerText : '') || '';
        return {
          okText: /has been sent|message sent|successfully|thank you|gracias|enviado|sent successfully|received your/i.test(t),
          aunForm: !!document.querySelector('#person_username_field_login, #message_contact_us_field'),
          captchaErr: /captcha code does not match|captcha code should be filled|captcha.*(match|invalid|do not match|no coincide)/i.test(t),
        };
      }).catch(() => ({}));
      if (st && st.okText) { confirmado = true; break; }
      if (st && st.captchaErr) { errorCaptcha = true; continue; }
      if (st && !st.aunForm) { confirmado = true; break; }
      await sleep(2500);
      const st2 = await page.evaluate(() => {
        const t = (document.body ? document.body.innerText : '') || '';
        return { okText: /has been sent|message sent|successfully|thank you|gracias|enviado|received your/i.test(t), aunForm: !!document.querySelector('#person_username_field_login, #message_contact_us_field'), captchaErr: /captcha code does not match|should be filled/i.test(t) };
      }).catch(() => ({}));
      if (st2 && st2.okText) { confirmado = true; break; }
      if (st2 && st2.captchaErr) { errorCaptcha = true; }
    }

    if (!confirmado) {
      keepOpen = true;
      return { ok: false, error: errorCaptcha ? `El captcha falló tras ${MAX_CAP} intentos. Dejo el navegador abierto.` : 'No se confirmó el envío. Dejo el navegador abierto para que verifiques.', keepOpen: true };
    }
    await sleep(1500);
    return { ok: true, subject, message };
  } catch (e) {
    const msg = String((e && e.message) || e);
    const retry = (typeof isNetworkError === 'function' && isNetworkError(e)) || /net::|ERR_|proxy|tunnel|ECONN|ETIMEDOUT|EAI_AGAIN|Navigation timeout/i.test(msg);
    return { ok: false, error: msg, retry };
  } finally {
    try { if (bridge) bridge.close(); } catch (_) {}
    if (!keepOpen && browser) { try { await browser.close(); } catch (_) {} }
  }
}

// Envuelve la apelación: si el proxy/red falla, REINTENTA; si falla el formulario, deja abierto.
async function appealContactUsClean(email, apiKey, proxy, intentos = 3) {
  let ultimo = { ok: false, error: 'sin intentos' };
  const logr = (o) => { try { fs.appendFileSync(path.join(LOGS_DIR, 'appeal-debug.log'), `[${new Date().toISOString()}] ${email} :: RESULT ${JSON.stringify({ ok: o && o.ok, keepOpen: o && o.keepOpen, retry: o && o.retry, error: o && o.error })}\n`); } catch (_) {} };
  for (let i = 1; i <= intentos; i++) {
    ultimo = await appealContactUsOnce(email, apiKey, proxy).catch((e) => ({ ok: false, error: e.message, retry: true }));
    if (ultimo && ultimo.ok) { logr(ultimo); return ultimo; }
    if (ultimo && ultimo.keepOpen) { logr(ultimo); return ultimo; }          // problema de formulario: no reintentar
    if (ultimo && ultimo.retry && i < intentos) { await sleep(4000); continue; } // proxy/red: reintenta
    logr(ultimo); return ultimo;
  }
  logr(ultimo); return ultimo;
}

// Apela una LISTA de correos, uno por uno, cada uno con su propio navegador limpio.
async function appealContactUsAll(emails, apiKey, proxy) {
  const lista = Array.isArray(emails) ? emails.map((e) => String(e || '').trim()).filter(Boolean) : [];
  const results = [];
  for (const email of lista) {
    const r = await appealContactUsClean(email, apiKey, proxy).catch((e) => ({ ok: false, error: e.message }));
    results.push({ email, ok: Boolean(r && r.ok) });
    await sleep(3000);
  }
  return { ok: true, results };
}

// Apelacion por el FORMULARIO (no por correo): abre /public/support_request, rellena
// email/telefono/detalle, resuelve el captcha (2Captcha) y envia "Send to Support".
async function appealSupportForm(page, controller) {
  let origin = 'https://megapersonals.eu';
  try { origin = new URL(siteUrls(controller).list).origin; } catch (_) {}
  controller.setCycleStage('removing', 'Abriendo formulario de apelación.');
  controller.log('📨 Abriendo el formulario de apelación (Support Request)...');
  try {
    await page.goto(`${origin}/public/support_request`, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) {
    controller.log(`No se pudo abrir la apelación: ${e.message}`);
    return false;
  }
  await sleep(2000);

  const email = (controller.cfg && controller.cfg.email) || '';  const phone = (controller.cfg && controller.cfg.adDetails && controller.cfg.adDetails.phone) || '';
  const detalle = appealDetail(controller);

  await page.evaluate((em, ph, det) => {
    const setVal = (el, v) => { if (!el || v === undefined || v === null || v === '') return; try { el.focus(); } catch (_) {} el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    const inputs = Array.from(document.querySelectorAll('input')).filter((i) => !['hidden', 'submit', 'button'].includes(i.type));
    const emailEl = inputs.find((i) => /email/i.test(`${i.type} ${i.name} ${i.placeholder}`)) || inputs[0];
    setVal(emailEl, em);
    const phoneEl = inputs.find((i) => /phone|tel|movil|móvil|cel/i.test(`${i.type} ${i.name} ${i.placeholder}`)) || inputs.find((i) => i !== emailEl && /text|tel/i.test(i.type));
    if (phoneEl) setVal(phoneEl, ph);
    const ta = document.querySelector('textarea');
    if (ta) setVal(ta, det);
  }, email, phone, detalle).catch(() => {});
  controller.log('📝 Formulario rellenado (email/teléfono/detalle).');
  await humanPause(1200, 2200);

  // Esperar a que el captcha esté presente.
  for (let i = 0; i < 12; i++) { if (await markImageCaptcha(page)) break; await sleep(1000); }
  await sleep(1500);

  if (controller.cfg && controller.cfg.apiKey2Captcha) {
    for (let intento = 1; intento <= 2; intento++) {
      try { await solveImageCaptcha(controller.cfg.apiKey2Captcha, page, controller); } catch (e) { controller.log(`Captcha (intento ${intento}): ${e.message}`); }
      await sleep(1200);
      const lleno = await page.evaluate(() => { const i = document.querySelector('#captcha_code') || document.querySelector('[data-momonga-captcha-input]') || document.querySelector('input[placeholder*="picture" i]'); return i ? String(i.value || '').trim().length : 0; }).catch(() => 0);
      if (lleno) { controller.log('Captcha escrito.'); break; }
      controller.log(`Captcha vacío; recargo y reintento (${intento}/2)...`);
      await reloadImageCaptcha(page).catch(() => {});
      await sleep(2500);
    }
  }

  const captchaLleno = await page.evaluate(() => { const i = document.querySelector('#captcha_code') || document.querySelector('[data-momonga-captcha-input]') || document.querySelector('input[placeholder*="picture" i]'); return i ? String(i.value || '').trim().length > 0 : true; }).catch(() => true);
  if (!captchaLleno) {
    controller.log('El captcha no se llenó; dejo el formulario abierto para completarlo a mano.');
    return false;
  }

  await humanPause(900, 1800);
  const enviado = await clickTextControl(page, ['send\\s+to\\s+support', 'send', 'enviar', 'submit'], 8000);
  if (!enviado) {
    controller.log('No encontré el botón "Send to Support". Déjalo abierto para terminar a mano.');
    return false;
  }
  await sleep(5000);
  await dismissOkModal(page).catch(() => {});
  controller.log('Apelación ENVIADA por el formulario de soporte.');
  notify(`Apelación enviada para "${controller.id}" (formulario de soporte).`);
  // Cerrar el navegador tras enviar con éxito.
  try { await controller.stop(); } catch (_) {}
  return true;
}

async function editExistingPost(page, controller, options = {}) {
  const urls = siteUrls(controller);
  const details = controller.cfg.adDetails || {};

  const fillForm = async () => {
    const headlineToUse = pickVariant(controller, 'headline');
    const textToUse = pickVariant(controller, 'text');
    await humanPause(500, 1200);
    await selectIamAndIsee(page, details);
    await humanPause(600, 1500);
    /* Nombre/Alias del anuncio: NO se llena (se deja vacio) */
    await humanPause(700, 1800);
    await fillText(page, headlineToUse, { label: '^\\s*headline' });
    await humanPause(800, 2000);
    await fillExactField(page, '#age', details.age) || await fillFieldByLabel(page, '^\\s*age', details.age);
    await humanPause(1200, 2800);
    await fillText(page, textToUse, { selector: '#body', label: '^\\s*body' });
    await humanPause(700, 1800);
    controller.setCycleStage('city', `Seleccionando ciudad: ${details.city}.`);
    const okCity = await selectCity(page, details.city, controller);
    await humanPause(700, 1600);
    await fillText(page, details.location, { selector: '#location', label: '^\\s*location' });
    await humanPause(600, 1500);
    await fillPhone(page, details.phone, controller);
    const telAfter = await page.evaluate(() => (document.getElementById('phonenumber') || {}).value).catch(() => '(err)');
    controller.log(`📞 Teléfono: quería "${details.phone}" ; el campo quedó "${telAfter}"`);
    if (await dismissPhoneLimitPopup(page)) {
      controller.log('⚠️ El sitio NO permitió cambiar el teléfono (solo 1 cambio por día).');
      controller.lastError = 'El sitio no permitió cambiar el teléfono (solo 1 cambio por día).';
      notify(`⚠️ No se pudo cambiar el teléfono en "${controller.id}": MegaPersonals solo permite 1 cambio por día.`).catch(() => {});
    }
    await humanPause(900, 2200);
    return okCity;
  };

  const uploadPhotos = async () => {
    if (!details.photosPath) return;
    const photosDir = path.resolve(__dirname, details.photosPath);
    if (!fs.existsSync(photosDir)) return;
    const photos = fs.readdirSync(photosDir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).map((n) => path.join(photosDir, n));
    if (!photos.length) return;
    const inputs = await page.$$('input[type="file"]');
    let input = null; let multi = false;
    for (const el of inputs) {
      const info = await el.evaluate((n) => ({ multiple: Boolean(n.multiple) })).catch(() => ({ multiple: false }));
      if (info.multiple) { input = el; multi = true; break; }
      if (!input) input = el;
    }
    if (!input) { controller.log('⚠️ No hay campo de fotos para subir.'); return; }
    try {
      if (multi) await input.uploadFile(...photos);
      else for (const p of photos) { await input.uploadFile(p); await sleep(700); }
      controller.log(`🖼️ ${photos.length} foto(s) cargadas.`);
    } catch (e) { controller.log(`⚠️ Subida de fotos falló: ${e.message}`); }
  };

  // En EDICION: quita las fotos previas del editor (mejor esfuerzo) y sube las nuevas.
  const replacePhotosInEdit = async () => {
    if (!details.photosPath) return;
    const photosDir = path.resolve(__dirname, details.photosPath);
    if (!fs.existsSync(photosDir)) return;
    const photos = fs.readdirSync(photosDir).filter((n) => /\.(jpg|jpeg|png|webp)$/i.test(n)).map((n) => path.join(photosDir, n));
    if (!photos.length) return;
    try {
      // Botón real de borrar foto: <div class="imagedelete" onclick="deleteImage(n)"></div>
      const onDialog = (d) => { try { d.accept(); } catch (_) {} };
      page.on('dialog', onDialog);
      let removed = 0;
      for (let i = 0; i < 24; i++) {
        const clicked = await trustedClick(page, () => {
          const els = Array.from(document.querySelectorAll('.imagedelete, [onclick*="deleteImage"]'));
          return els.find((e) => e.offsetParent !== null) || null;
        });
        if (!clicked) break;
        removed++;
        await humanPause(500, 1200);
      }
      page.off('dialog', onDialog);
      if (!removed) {
        removed = await page.evaluate(() => {
          let n = 0;
          const els = Array.from(document.querySelectorAll('a, button, span, i, div'));
          for (const el of els) {
            if (el.offsetParent === null) continue;
            const cls = (el.className || '').toString();
            const looksDelete = /(delete|remove|borrar)[-_]?(photo|foto|image)/i.test(cls)
              || /(delete|remove)(photo|foto|image)/i.test(el.id || '');
            if (!looksDelete) continue;
            const wrap = el.closest('div, li, td');
            if (wrap && wrap.querySelector('img')) { try { el.click(); n++; } catch (_) {} }
          }
          return n;
        }).catch(() => 0);
      }
      if (removed) { controller.log(`🧹 ${removed} foto(s) previas quitadas del editor.`); await humanPause(800, 1800); }
    } catch (_) {}
    await uploadPhotos();
  };

  const saveAndConfirm = async () => {
    controller.setCycleStage('publishing', 'Guardando anuncio.');
    await humanPause(1500, 3200);
    let clicked = await clickTextControl(page, ['save', 'publish', 'update', 'post\\s+ad', 'guardar', 'aplicar', 'publicar'], 8000);
    if (!clicked) {
      clicked = await trustedClick(page, () => {
        const direct = document.getElementById('input_send') || document.querySelector('.myButton.previewbutton');
        if (direct && direct.offsetParent !== null) return direct;
        const form = document.querySelector('form');
        const submit = form && form.querySelector('button[type="submit"], input[type="submit"]');
        if (submit && submit.offsetParent !== null && !submit.disabled) return submit;
        return Array.from(document.querySelectorAll('button, input[type="submit"], a'))
          .find((el) => el.offsetParent !== null && !el.disabled && /save|update|publish|guardar|publicar|send/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''}`)) || null;
      });
    }
    if (!clicked) return false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const href = await page.evaluate(() => window.location.href).catch(() => '');
      // Ya estamos en la lista de anuncios: terminado.
      if (/\/users\/posts(\/list)?\/?$/.test(href)) return true;

      // Página/modal "tus imágenes fueron revisadas": pulsar el OK (id success-ok / buttonOk.png).
      const enRevisado = page.url().includes('pendingImages')
        || await page.evaluate(() => /have\s+been\s+reviewed/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      if (enRevisado) {
        const ok = await clickPendingImagesOk(page).catch(() => false);
        controller.log(ok ? '🖼️ OK de "imágenes revisadas" pulsado.' : '⚠️ No encontré el OK de "imágenes revisadas".');
        await sleep(2000);
        continue;
      }

      // Página "Sweet! Your Post has been published": volver a MY POSTS.
      if (href.includes('success_publish')) {
        await dismissOkModal(page).catch(() => {});
        const went = await clickTextControl(page, ['my\\s+posts', 'mis\\s+anuncios'], 5000).catch(() => false);
        if (went) await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
        else await page.goto(urls.manage, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        return true;
      }

      await confirmTokenPopup(page).catch(() => {});
      if (await detectCaptchaRejected(page)) { await reloadImageCaptcha(page).catch(() => {}); await waitForManualCaptcha(page, controller).catch(() => {}); }
      if (await detectFormValidationError(page)) { controller.log('⚠️ El sitio rechazo el guardado (validacion de categorias/telefono).'); return false; }
      const formGone = await page.evaluate(() => !document.getElementById('headline') && !document.getElementById('body') && !document.querySelector('input[name="headline"], textarea[name="body"]')).catch(() => false);
      if (formGone) return true;
      await sleep(1500);
    }
    return false;
  };

  try {
    let modo = 'edit';
    // En modo "strict" (edicion pedida desde el panel/SaaS) NUNCA asumimos crear por estar
    // en /users/posts/create: siempre vamos a Manage Posts y pulsamos Edit Post.
    let yaEnCreate = !options.strict && page.url().includes('/users/posts/create');

    if (options.forceCreate) {
      modo = 'create';
      controller.setCycleStage('filling', 'Abriendo Create Post (nuevo anuncio / Write New).');
      await page.goto(urls.create, { waitUntil: 'networkidle2', timeout: 60000 });
      yaEnCreate = true;
      controller.log('ℹ️ Creando un anuncio NUEVO (Write New).');
    } else if (yaEnCreate) {
      modo = 'create';
      controller.log('ℹ️ Ya estamos en /users/posts/create: lleno y publico.');
    } else {
      controller.setCycleStage('removing', 'Abriendo Manage Posts (editar).');
      await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 });
      if (await ensureSession(page, controller)) {
        await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      }
      if (await checkForBlock(page, controller)) return false;

      const clicked = await trustedClick(page, () => {
        const direct = document.querySelector('#edit-post-id')
          || document.querySelector('a[href*="/users/posts/edit"], a[href*="/posts/edit"]')
          || document.querySelector('input[value*="Edit" i], button[id*="edit" i]');
        if (direct && direct.offsetParent !== null) return direct;
        return Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div'))
          .find((el) => el.offsetParent !== null && /edit\s*post|editar\s*anuncio/i.test(`${el.innerText || ''} ${el.value || ''} ${el.id || ''}`)) || null;
      });

      if (!clicked) {
        controller.log('ℹ️ No hay post para editar (quizá borrado). Paso a CREATE POST.');
        modo = 'create';
      } else {
        await sleep(2500);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await humanPause(1200, 2600);
      }
    }

    if (modo === 'create' && !yaEnCreate) {
      controller.setCycleStage('filling', 'Abriendo Create Post (no había post para editar).');
      await page.goto(urls.create, { waitUntil: 'networkidle2', timeout: 60000 });
    }

    if (await checkForBlock(page, controller)) return false;

    controller.setCycleStage('filling', modo === 'edit' ? 'Editando datos del anuncio.' : 'Creando anuncio (no había post).');
    const okCity = await fillForm();
    if (!okCity) return false;
    // Paso 1 -> Paso 2 (fotos + captcha). Igual que el flujo de crear/remover.
    if (!(await clickNextStep(page, controller))) return false;
    const currentHash = hashPhotoSet(details.photosPath);
    if (modo === 'create') {
      await uploadPhotos();
      controller.lastPhotoHash = currentHash;
    } else if (currentHash && controller.lastPhotoHash && currentHash === controller.lastPhotoHash) {
      // Las fotos no cambiaron: se conservan las que ya tiene el anuncio (no se duplican).
      controller.log('🖼️ Fotos sin cambios: se conservan las del anuncio (no se duplican).');
    } else {
      // Las fotos cambiaron (o no hay registro previo): quita las viejas y pone las nuevas.
      await replacePhotosInEdit();
      controller.lastPhotoHash = currentHash;
    }
    if (!(await waitForManualCaptcha(page, controller))) return false;

    const confirmed = await saveAndConfirm();
    if (!confirmed) {
      if (await checkForBlock(page, controller)) return false;
      const msg = modo === 'edit' ? 'No se confirmó el guardado de la edición.' : 'No se confirmó la publicación (Create Post).';
      controller.setCycleStage('error', msg);
      controller.log(`❌ ${msg}`);
      notify(`❌ ${msg} en "${controller.id}".`);
      return false;
    }

    controller.log(modo === 'edit' ? '✅ Anuncio editado y guardado (sin borrar el post).' : '✅ Anuncio creado/publicado (no había post).');
    controller.setCycleStage('completed', modo === 'edit' ? 'Edición confirmada.' : 'Publicación confirmada.');
    controller.recordBump();
    await dismissOkModal(page).catch(() => {});
    await sleep(800);
    return true;
  } catch (error) {
    controller.log(`❌ Error aplicando cambios en la cuenta real: ${error.message}`);
    notify(`❌ Error aplicando cambios en "${controller.id}": ${error.message}`);
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
  // Fotos del anuncio: estan en el CDN de fotos (img1/img2.drome6.com/imgs/...).
  // Se toman del CDN aunque esten en data-src (lazy, sin cargar). Se DESCARTAN los
  // recursos del propio sitio (mismo dominio: logos, destellos, iconos, banners...).
  return page.evaluate(() => {
    const host = location.host;
    const fuente = (img) => img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
    const esAdorno = (u) => {
      try {
        const x = new URL(u, location.href);
        if (/\/resources\//i.test(x.pathname)) return true;
        if (/\/(logo|sprite|icon|banner|header|footer|emoji|explosion|favicon|placeholder|divider|notices|bug|starburst|sticker|button)/i.test(x.pathname)) return true;
        return false;
      } catch (_) { return true; }
    };
    const porTamano = (min, excluirMismoHost) => {
      const urls = new Set();
      document.querySelectorAll('img').forEach((img) => {
        const s = fuente(img);
        if (!s || !/^https?:/i.test(s) || esAdorno(s)) return;
        try { if (excluirMismoHost && new URL(s, location.href).host === host) return; } catch (_) { return; }
        if (img.naturalWidth >= min && img.naturalHeight >= min) urls.add(s);
      });
      return [...urls];
    };
    const cdn = new Set();
    document.querySelectorAll('img').forEach((img) => {
      [fuente(img), img.getAttribute('data-src'), img.getAttribute('data-lazy-src')].forEach((s) => {
        if (s && /^https?:/i.test(s) && /drome6\.com/i.test(s) && !esAdorno(s)) cdn.add(s);
      });
    });
    return {
      cdn: [...cdn],
      big: porTamano(300, true), mid: porTamano(150, true), small: porTamano(80, true),
      bigAny: porTamano(300, false), midAny: porTamano(150, false), smallAny: porTamano(80, false),
    };
  }).then((r) => [r.cdn, r.big, r.mid, r.small, r.bigAny, r.midAny, r.smallAny].find((a) => a.length) || []).catch(() => []);
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

// IP REAL de salida del proxy (consultada A TRAVÉS del proxy), para la auditoría.
// Ligero: usa el puente SOCKS5 + undici, sin abrir navegador.
async function lookupExitIp(proxy) {
  if (!proxy || !proxy.host) return { skipped: true };
  let bridge = null;
  let dispatcher = null;
  try {
    let proxyUrl;
    if (proxy.type === 'socks5') {
      bridge = await startSocksBridge(proxy);
      proxyUrl = `http://127.0.0.1:${bridge.address().port}`;
    } else {
      const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@` : '';
      proxyUrl = `http://${auth}${proxy.host}:${proxy.port}`;
    }
    dispatcher = new ProxyAgent(proxyUrl);
    const res = await undiciFetch('https://ipinfo.io/json', { dispatcher, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    return { ip: info.ip, org: info.org || '', city: info.city || '', region: info.region || '', country: info.country || '', timezone: info.timezone || '' };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (dispatcher) await dispatcher.close().catch(() => {});
    if (bridge) { try { bridge.close(); } catch (_) {} }
  }
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
  // Solo se reutiliza un resultado VÁLIDO (los fallos NO se cachean, para reintentar).
  if (cached && cached.data && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;

  // Varios proveedores por si uno falla o bloquea al proxy. Todos dan timezone.
  const endpoints = [
    { url: 'https://ipinfo.io/json', map: (o) => o && o.ip ? { query: o.ip, country: o.country, city: o.city || o.region, timezone: o.timezone, loc: o.loc } : null },
    { url: 'https://ipwho.is/', map: (o) => o && o.ip && o.success !== false ? { query: o.ip, country: o.country_code || o.country, city: o.city, timezone: (o.timezone && o.timezone.id) || o.timezone, loc: (o.latitude != null ? `${o.latitude},${o.longitude}` : '') } : null },
    { url: 'https://ipapi.co/json/', map: (o) => o && o.ip ? { query: o.ip, country: o.country_code, city: o.city, timezone: o.timezone, loc: (o.latitude != null ? `${o.latitude},${o.longitude}` : '') } : null },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ep of endpoints) {
      let tmp;
      try {
        tmp = await browser.newPage();
        if (proxy.type !== 'socks5' && proxy.username) {
          await tmp.authenticate({ username: proxy.username, password: proxy.password || '' }).catch(() => {});
        }
        await tmp.goto(ep.url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        const txt = await tmp.evaluate(() => (document.body ? document.body.innerText : ''));
        const info = ep.map(JSON.parse(txt));
        if (info && info.timezone) {
          const [lat, lon] = String(info.loc || '').split(',').map(Number);
          const data = {
            status: 'success',
            query: info.query,
            country: info.country || '',
            city: info.city || '',
            timezone: info.timezone,
            lat: Number.isFinite(lat) ? lat : undefined,
            lon: Number.isFinite(lon) ? lon : undefined,
          };
          proxyGeoCache.set(key, { at: Date.now(), data });
          return data;
        }
      } catch (_) {
      } finally {
        if (tmp) await tmp.close().catch(() => {});
      }
    }
    await sleep(1200);
  }
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

// Igual que downloadAndSanitizePhoto pero baja la foto DENTRO del navegador (con cookies de
// sesión y TLS de Chrome), así el CDN (img*.drome6.com) no responde 403 de Cloudflare.
// Guarda un buffer de imagen como foto sanitizada (mismo pipeline).
async function savePhotoBuffer(buffer, outputFolder, profileId) {
  const targetDir = outputFolder || path.join(__dirname, 'profiles', profileId, 'photos');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const outputPath = path.join(targetDir, `sanitized_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
  await sharp(buffer)
    .resize(1080, 1920, { fit: 'inside', withoutEnlargement: true })
    .modulate({ brightness: 1.01, saturation: 1.02 })
    .jpeg({ quality: 95, mozjpeg: true })
    .toFile(outputPath);
  return outputPath;
}

async function downloadPhotoViaPage(page, imageUrl, outputFolder, profileId) {
  const racer = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + tag)), ms))]);
  try {
    let b64 = null; let via = '';

    // 1) fetch dentro de la página imitando una petición de imagen.
    const r1 = await racer(page.evaluate(async (u) => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(u, { credentials: 'include', signal: ctl.signal, headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } });
        clearTimeout(t);
        if (!r.ok) return { err: 'HTTP ' + r.status };
        const buf = new Uint8Array(await r.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        return { b64: btoa(s) };
      } catch (e) { return { err: String((e && e.message) || e) }; }
    }, imageUrl), 12000, 'fetch').catch((e) => ({ err: e.message }));
    if (r1 && r1.b64) { b64 = r1.b64; via = 'fetch'; }

    // 2) dibujar el <img> ya cargado en un canvas (si el CDN permite CORS).
    if (!b64) {
      const r2 = await racer(page.evaluate((u) => {
        try {
          const img = Array.from(document.querySelectorAll('img')).find((i) => (i.currentSrc || i.src) === u);
          if (!img || !img.naturalWidth) return { err: 'no img cargada' };
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return { b64: c.toDataURL('image/jpeg', 0.95).split(',')[1] };
        } catch (e) { return { err: String((e && e.message) || e) }; }
      }, imageUrl), 8000, 'canvas').catch((e) => ({ err: e.message }));
      if (r2 && r2.b64) { b64 = r2.b64; via = 'canvas'; }
    }

    if (!b64) throw new Error('no se pudo descargar');
    try { console.log(`🖼️ Foto bajada vía ${via}.`); } catch (_) {}
    return await savePhotoBuffer(Buffer.from(b64, 'base64'), outputFolder, profileId);
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
    this.blocked = false;
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
    this.lastPhotoHash = null;
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
    if (stage === 'error' && detail) this.lastError = { message: String(detail).slice(0, 200), at: Date.now() };
    else if (stage === 'completed') this.lastError = null;
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

    // Antes de abrir, cierra cualquier Chrome viejo que siga usando este perfil.
    // Si no, Chrome abre una pestaña en blanco en la instancia anterior y Puppeteer no la controla.
    await closeStaleChrome(profileDir, this.cfg.port, (message) => this.log(message)).catch(() => {});

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
    // IP publica del proxy (para que WebRTC la muestre y no la IP real)
    const proxyPublicIp = (geo && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(geo.query || ''))) ? geo.query : null;
    this._proxyIp = proxyPublicIp || this._proxyIp || null;
    if (proxyPublicIp) this.log(`🛡️ WebRTC mostrara la IP del proxy (${proxyPublicIp}).`);
    await client.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
    await page.setGeolocation({ latitude, longitude, accuracy: 100 });
    await page.setBypassCSP(true);

    const chromeVersion = await browser.version().catch(() => '');
    const chromeMajor = (String(chromeVersion).match(/(\d+)/) || [])[1] || '140';
    const device = devicePreset(this.cfg.device, chromeMajor);
    this.log(`Dispositivo: ${device.kind === 'android' ? `${device.model} (Chrome ${chromeMajor})` : 'iPhone (Safari)'}`);
    await page.setExtraHTTPHeaders(chHeadersFor(device, chromeMajor));
    await page.emulate({
      userAgent: device.userAgent,
      viewport: device.viewport
    });

    // Plataforma / idioma / userAgentData a NIVEL CDP (NO con getters JS: los detectan
    // los scanners tipo BrowserScan "Bot Detection"). Así el UA, la plataforma y las
    // Client Hints quedan coherentes sin dejar rastro de sobreescritura por JavaScript.
    try { await applyUaOverride(client, device, chromeMajor); } catch (_) {}

    // Anti-deteccion: oculta automatizacion y enmascara la huella por perfil.
    const seed = String(this.id) + '|' + MACHINE_SALT;
    const deviceKind = device.kind;
    const stealthFn = (seedStr, kind, major, model, platformName, androidVersion, proxyIp, screenW, screenH) => {
      let s = 2166136261 >>> 0;
      for (let i = 0; i < seedStr.length; i++) { s ^= seedStr.charCodeAt(i); s = Math.imul(s, 16777619) >>> 0; }
      for (let i = 0; i < 5; i++) s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const rand = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];

      // IMPORTANTE: NO se sobreescriben webdriver/plugins/languages/platform/vendor/etc.
      // con getters JS: los scanners (BrowserScan "Bot Detection") los detectan.
      // La plataforma, el idioma y userAgentData se fijan a nivel CDP en launchProfile().

      // Fuentes: limita la lista visible (canvas measureText)
      try {
        const ALLOWED = ['arial', 'helvetica', 'times new roman', 'courier new', 'georgia', 'verdana', 'tahoma', 'trebuchet ms', 'arial black', 'comic sans ms', 'impact', 'sans-serif', 'serif', 'monospace', 'system-ui', '-apple-system', 'roboto', 'noto sans', 'segoe ui', 'calibri'];
        const origMeasure = CanvasRenderingContext2D.prototype.measureText;
        CanvasRenderingContext2D.prototype.measureText = function (text) {
          try {
            const f = String(this.font || '');
            if (f && !ALLOWED.some((a) => f.toLowerCase().includes(a))) {
              const saved = this.font;
              const mt = f.match(/^([\s\S]*?\d+(?:\.\d+)?(?:px|pt|em|rem|vw|vh|%))\b/);
              this.font = mt ? `${mt[1]} sans-serif` : '16px sans-serif';
              const r = origMeasure.call(this, text);
              this.font = saved;
              return r;
            }
          } catch (_) {}
          return origMeasure.call(this, text);
        };
      } catch (_) {}

      // WebRTC: NO filtra la IP real y muestra la del proxy.
      try {
        const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
        if (OrigRTC) {
          const strip = (cfg) => { try { if (cfg && cfg.iceServers) cfg.iceServers = []; } catch (_) {} return cfg; };
          const fireFake = (pc) => {
            if (!proxyIp || !pc) return;
            try {
              const cand = `candidate:1 1 udp 1677729535 ${proxyIp} ${40000 + Math.floor(rand() * 20000)} typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag ${Math.random().toString(36).slice(2, 6)} network-cost 999`;
              const ice = new RTCIceCandidate({ candidate: cand, sdpMid: '0', sdpMLineIndex: 0 });
              pc.dispatchEvent(new RTCPeerConnectionIceEvent('icecandidate', { candidate: ice }));
            } catch (_) {}
          };
          const fake = (pc) => {
            if (!proxyIp || !pc) return;
            [60, 300, 900].forEach((d) => setTimeout(() => fireFake(pc), d));
          };
          const origSetConfig = OrigRTC.prototype.setConfiguration;
          if (origSetConfig) OrigRTC.prototype.setConfiguration = function (cfg) { return origSetConfig.call(this, strip(cfg)); };
          const wrap = (name) => {
            const orig = OrigRTC.prototype[name];
            if (!orig) return;
            OrigRTC.prototype[name] = function () { const r = orig.apply(this, arguments); fake(this); return r; };
          };
          wrap('setLocalDescription');
          wrap('createOffer');
          wrap('createAnswer');
          const Patched = function (config, ...rest) { return new OrigRTC(strip(config), ...rest); };
          Patched.prototype = OrigRTC.prototype;
          window.RTCPeerConnection = Patched;
          if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Patched;
        }
      } catch (_) {}

      // Coherencia con el dispositivo: Safari no tiene window.chrome.
      if (kind === 'android') {
        try {
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = {};
        } catch (_) {}
      } else {
        try { delete window.chrome; } catch (_) {}
      }

      // userAgentData / hardwareConcurrency / deviceMemory: NO se tocan por JS.
      // userAgentData se fija por CDP (Emulation.setUserAgentOverride + userAgentMetadata).

      // WebGL: GPU MÓVIL variada por perfil. Sin esto, TODAS las cuentas de la misma PC
      // muestran la GPU real (NVIDIA) y el sitio las vincula. Se prioriza no filtrar
      // la GPU real (el "WebGL exception" del scanner es solo un -5% de score, no detección).
      try {
        const gpu = kind === 'android'
          ? pick([
            { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 640, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 650, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G78 MP20, OpenGL ES 3.2)' },
            { vendor: 'Google Inc. (ARM)', renderer: 'ANGLE (ARM, Mali-G77 MP11, OpenGL ES 3.2)' }
          ])
          : { vendor: 'Apple Inc.', renderer: 'Apple GPU' };
        const GL_EXTRA = { 3379: 16384, 34024: 16384, 34930: 16, 35660: 16, 35661: 32, 36349: 1024, 36347: 1024 };
        const patchGL = (proto) => {
          if (!proto || !proto.getParameter) return;
          const orig = proto.getParameter;
          proto.getParameter = function (p) {
            if (p === 37445) return gpu.vendor;
            if (p === 37446) return gpu.renderer;
            if (p === 3386) { try { return new Int32Array([16384, 16384]); } catch (_) { return orig.apply(this, arguments); } }
            if (Object.prototype.hasOwnProperty.call(GL_EXTRA, p)) return GL_EXTRA[p];
            return orig.apply(this, arguments);
          };
        };
        patchGL(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
        patchGL(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
      } catch (_) {}

      // hardwareConcurrency / deviceMemory tipo móvil (variado por perfil).
      try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => pick([4, 6, 8]) }); } catch (_) {}
      try { Object.defineProperty(navigator, 'deviceMemory', { get: () => pick([4, 8]) }); } catch (_) {}

      // maxTouchPoints coherente con móvil. Un SOLO getter (no dispara bot detection) y evita
      // el aviso "Touch support exception" (el UA dice móvil pero el equipo no es táctil).
      try { Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 }); } catch (_) {}

      // Semilla estable (numérica) para ruido DETERMINISTA: mismo canvas => mismo resultado
      // (así no parece "tampering"), pero distinto entre perfiles.
      let seedInt = 2166136261 >>> 0;
      for (let i = 0; i < String(seedStr).length; i++) { seedInt ^= String(seedStr).charCodeAt(i); seedInt = Math.imul(seedInt, 16777619) >>> 0; }
      seedInt = seedInt >>> 0;

      // Canvas: ruido determinista (salvo el canvas del captcha).
      try {
        const origGet = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function () {
          const data = origGet.apply(this, arguments);
          try {
            const cv = this.canvas;
            if (cv && cv.getAttribute && cv.getAttribute('data-momonga-skip') === '1') return data;
            const d = data.data;
            if (d.length >= 4) {
              let h = seedInt >>> 0;
              for (let i = 0; i < d.length; i += 131) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
              const idx = (h % Math.floor(d.length / 4)) * 4;
              d[idx] = (d[idx] + (h & 3) - 1 + 256) % 256;
            }
          } catch (_) {}
          return data;
        };
      } catch (_) {}

      // Audio: offset determinista por perfil (no aleatorio) para no parecer manipulado.
      try {
        const origGetFloat = AnalyserNode.prototype.getFloatFrequencyData;
        const audioOff = (seedInt & 7) * 0.0000001;
        AnalyserNode.prototype.getFloatFrequencyData = function (array) {
          origGetFloat.apply(this, arguments);
          try { if (array && array.length) array[0] = array[0] + audioOff; } catch (_) {}
        };
      } catch (_) {}
    };
    await page.evaluateOnNewDocument(stealthFn, seed, deviceKind, chromeMajor, device.model, device.platform, device.androidVersion, proxyPublicIp, device.viewport.width, device.viewport.height);

    // Aplica el MISMO disfraz (emulacion + anti-deteccion) a CADA pestaña nueva
    // (browserleaks, pixelscan, apelacion, chequeo, etc.). Devuelve una promesa
    // compartida para que quien la llame ESPERE a que el sigilo quede inyectado.
    const applyToNewPage = (p) => {
      if (!p) return Promise.resolve();
      if (!p.__momongaApplyPromise) {
        p.__momongaApplyPromise = (async () => {
          try { await p.emulate({ userAgent: device.userAgent, viewport: device.viewport }); } catch (_) {}
          try { await p.setExtraHTTPHeaders(chHeadersFor(device, chromeMajor)); } catch (_) {}
          try { await p.setGeolocation({ latitude, longitude, accuracy: 100 }); } catch (_) {}
          try { await p.setBypassCSP(true); } catch (_) {}
          if (proxy && proxy.host && proxy.type !== 'socks5' && proxy.username !== undefined && proxy.password !== undefined) {
            try { await p.authenticate({ username: proxy.username, password: proxy.password }); } catch (_) {}
          }
          try {
            const cdp = await p.target().createCDPSession();
            await cdp.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
            await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
            await applyUaOverride(cdp, device, chromeMajor);
          } catch (_) {}
          try { await p.evaluateOnNewDocument(stealthFn, seed, deviceKind, chromeMajor, device.model, device.platform, device.androidVersion, proxyPublicIp, device.viewport.width, device.viewport.height); } catch (_) {}
        })().catch(() => {});
      }
      return p.__momongaApplyPromise;
    };
    browser.on('targetcreated', async (target) => {
      try {
        if (target.type() !== 'page') return;
        const p = await target.page();
        if (p) await applyToNewPage(p);
      } catch (_) {}
    });
    // Para que otras funciones (chequeo, etc.) puedan preparar sus pestañas.
    this._applyPage = applyToNewPage;

    const fp = await page.evaluate(() => ({
      ua: navigator.userAgent,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: navigator.language
    }));
    this.log(`Fingerprint: TZ=${fp.tz} | Lang=${fp.lang}`);
    this.log('🛡️ Anti-detección + anti-fuga WebRTC activadas.');

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
      // Navegacion robusta: si el sitio mantiene conexiones vivas (websockets/polling),
      // 'networkidle2' no termina y la ventana se queda en blanco. Reintenta y cae a
      // 'domcontentloaded'. Si aun asi sigue en about:blank, avisa y cierra.
      let navego = false;
      for (let intento = 1; intento <= 2 && !navego; intento++) {
        try {
          await page.goto(urls.manage, { waitUntil: 'networkidle2', timeout: 35000 });
        } catch (_) {
          try { await page.goto(urls.manage, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (_) {}
        }
        let actual = '';
        try { actual = page.url(); } catch (_) {}
        navego = Boolean(actual) && !/^about:blank/i.test(actual);
        if (!navego && intento < 2) this.log('La pagina no cargo; reintentando...');
      }
      if (!navego) {
        this.setCycleStage('error', 'No se pudo cargar MegaPersonals. Revisa el proxy o inicia sesion.');
        this.log('❌ No se pudo cargar la pagina (proxy/sesion). Se cierra el navegador.');
        notify(`❌ "${this.id}": no se pudo cargar MegaPersonals (revisa el proxy o la sesion).`);
        await this.stop();
        return false;
      }
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
      // Chequeo de seguridad AL ABRIR (para que verifique todo de una vez).
      try {
        const safety = await runSafetyCheck(this);
        reportSafetyCheck(this, safety, { pauseOnFail: false });
      } catch (_) {}
      return true;
    } catch (error) {
      this.log(`Error crítico: ${error.message}`);
      this.setCycleStage('error', `No se pudo abrir: ${String(error.message || '').slice(0, 160)}`);
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
    if (this.blocked) {
      this.log('⛔ Perfil marcado como BLOQUEADO: no se reinicia solo (para no recargar la página y poder apelar). Usa "Desmarcar bloqueada" para reactivarlo.');
      return;
    }
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

    // Chequeo de seguridad antes de arrancar (IP/proxy, fraud score, fuga WebRTC).
    const safety = await runSafetyCheck(this).catch(() => null);
    if (safety) {
      reportSafetyCheck(this, safety);
      if (!safety.ok) { this.pause(); return; }
    }

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
    this.startSafetyWatch();
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

  startSafetyWatch() {
    if (this._safetyWatch) clearInterval(this._safetyWatch);
    // Repite el chequeo de seguridad cada 1 hora mientras el perfil esta en marcha.
    this._safetyWatch = setInterval(async () => {
      if (this.started && !this.paused && this.browser) {
        const check = await runSafetyCheck(this).catch(() => null);
        if (check) reportSafetyCheck(this, check);
      }
    }, 60 * 60 * 1000);
    if (this._safetyWatch.unref) this._safetyWatch.unref();
  }

  pause() {
    if (!this.started) return;
    this.paused = true;
    if (this._cycleTimer) clearTimeout(this._cycleTimer);
    if (this._countdownTimer) clearInterval(this._countdownTimer);
    if (this._repostTimer) clearTimeout(this._repostTimer);
    if (this._blockWatch) clearInterval(this._blockWatch);
    if (this._safetyWatch) clearInterval(this._safetyWatch);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    this._blockWatch = null;
    this._safetyWatch = null;
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
    this.startSafetyWatch();
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
    if (this._safetyWatch) clearInterval(this._safetyWatch);
    this._cycleTimer = null;
    this._countdownTimer = null;
    this._repostTimer = null;
    this._blockWatch = null;
    this._safetyWatch = null;
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

    // SIEMPRE aleatorio dentro del rango que configures (Bump mín – Bump máx).
    // Si pones mín = máx, entonces es fijo (no hay rango).
    const minMs = min * 60 * 1000;
    const maxMs = max * 60 * 1000;
    const waitMs = maxMs > minMs
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
    // Respeta "1 peticion cada 5 segundos" del sitio antes de seguir.
    await sleep(4500);

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
    if (this._rateLimited) {
      this._rateLimited = false;
      this.log('⏳ El sitio pidió esperar (rate-limit). Reintento en 1 min (no cuenta como fallo).');
      this.scheduleRetrySoon(1);
      return;
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
      notify(`⚠️ REPOST falló en "${this.id}": ${error.message}`);
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
      notify(`⚠️ PUBLICAR falló en "${this.id}": ${error.message}`);
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
      notify(`⚠️ REPOST (manual) falló en "${this.id}": ${error.message}`);
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
    // Respeta "1 peticion cada 5 segundos" del sitio antes de seguir.
    await sleep(4500);

    // Revisa la sesión antes de operar; si murió, re-loguea.
    await ensureSession(this.page, this);
    if (await checkForBlock(this.page, this)) {
      // Si fue un rate-limit (no paró todo), reprograma para reintentar.
      if (this.started && !this.paused) this.scheduleNext();
      return;
    }

    if (this._pendingEdit) {
      this._pendingEdit = false;
      this.log('✏️ Aplicando cambios pendientes del anuncio (edicion diferida)...');
      await editExistingPost(this.page, this, { strict: true });
    } else if (this.settings.rotateAds) {
      await bumpAllAdsOneByOne(this.page, this);
    } else {
      await performBump(this.page, this);
    }

    if (this._rateLimited) {
      this._rateLimited = false;
      this.log('⏳ El sitio pidió esperar (rate-limit). Reintento en 1 min.');
      this.scheduleRetrySoon(1);
      return;
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
        controller.lastPhotoHash = saved.lastPhotoHash || null;
        controller.blocked = Boolean(saved.blocked);
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
    if (!puedeCrearPerfil()) {
      const msg = !licenciaVigente()
        ? 'Tu licencia no esta vigente. Renueva para crear perfiles.'
        : `Alcanzaste el limite de ${limitePerfiles()} perfil(es) de tu plan.`;
      return res.status(403).json({ error: msg });
    }
    const { id, port, intervalMinutes, bumpMinMinutes, bumpMaxMinutes, url, email, password, supportEmail, supportUrl, proxy, adDetails, limits, device, rotateUrl, settings, postsARotar } = req.body || {};
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
      rotateUrl: String(rotateUrl || '').trim(),
      intervalMinutes: minVal,
      bumpMinMinutes: minVal,
      bumpMaxMinutes: maxVal,
      url: String(url || DEFAULT_URL).trim() || DEFAULT_URL,
      device: isValidDevice(device) ? device : 'iphone',
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
      },
      settings: {
        rotateAds: Boolean(settings && settings.rotateAds),
        randomizedDelay: settings && 'randomizedDelay' in settings ? Boolean(settings.randomizedDelay) : true,
        publishOnStart: Boolean(settings && settings.publishOnStart)
      },
      postsARotar: Math.max(0, Math.floor(Number(postsARotar) || 0))
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

    if ('bumpMinMinutes' in body || 'bumpMaxMinutes' in body || 'intervalMinutes' in body) {
      let min = Math.max(1, Math.round(Number(body.bumpMinMinutes) || Number(body.intervalMinutes) || profile.bumpMinMinutes || profile.intervalMinutes || 16));
      let max = Math.max(min, Math.round(Number(body.bumpMaxMinutes) || min));
      profile.bumpMinMinutes = min; profile.bumpMaxMinutes = max; profile.intervalMinutes = min;
      const ctrl = controllers.get(profile.id);
      if (ctrl) { ctrl.cfg.bumpMinMinutes = min; ctrl.cfg.bumpMaxMinutes = max; ctrl.cfg.intervalMinutes = min; if (ctrl.started && !ctrl.paused) ctrl.scheduleNext(); }
    }

    if ('postsARotar' in body) {
      const n = Math.max(0, Math.floor(Number(body.postsARotar) || 0));
      profile.postsARotar = n;
      const ctrl = controllers.get(profile.id);
      if (ctrl) ctrl.cfg.postsARotar = n;
    }

    if ('apiKey2Captcha' in body) {
      profile.apiKey2Captcha = String(body.apiKey2Captcha || '').trim();
    }

    if ('rotateUrl' in body) {
      profile.rotateUrl = String(body.rotateUrl || '').trim();
    }

    if ('device' in body) {
      profile.device = isValidDevice(body.device) ? body.device : 'iphone';
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

// Llama al enlace de cambio de IP del proveedor (ProxyPanel y similares).
app.post('/api/profiles/:id/rotate-ip', async (req, res) => {
  try {
    const config = loadConfig();
    const profile = config.find((item) => item.id === req.params.id);
    if (!profile) return res.status(404).json({ success: false, error: 'Perfil no encontrado.' });
    const url = String(profile.rotateUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Configura primero el enlace de cambio de IP.' });
    }

    const controller = controllers.get(profile.id);
    const ipBefore = (controller && controller._proxyIp) || null;
    let message = '';
    try {
      const r = await undiciFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(30000)
      });
      message = String(await r.text().catch(() => '')).trim().slice(0, 300);
      if (!r.ok) {
        return res.status(502).json({ success: false, error: `El enlace respondió HTTP ${r.status}.`, message });
      }
    } catch (error) {
      return res.status(502).json({ success: false, error: `No se pudo llamar al enlace: ${error.message}` });
    }

    if (controller) controller.log(`🔄 Cambio de IP solicitado. Respuesta: ${message || 'OK'}`);
    notify(`🔄 "${profile.id}": cambio de IP solicitado (${message || 'OK'}).`);
    io.emit('profile-rotate', { id: profile.id, message, at: Date.now(), ipBefore });
    res.json({ success: true, message: message || 'Cambio de IP solicitado.', ipBefore });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lee el anuncio actual del perfil, limpia metadatos de las fotos y actualiza adDetails.
async function scrapeAndSaveAd(controller, photoBuffers) {
  try { fs.writeFileSync(path.join(LOGS_DIR, `dump-${controller.id}.html`), await controller.page.content(), 'utf8'); } catch (_) {}

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
  data.phone = soloTelefono(data.phone);
  controller.log(`📥 Leído de la página actual -> ciudad: "${data.city}", edad: "${data.age}", texto: ${data.text ? data.text.length + ' caracteres' : 'vacío'}`);

  // Baja la pagina para forzar la carga de fotos "lazy" antes de leerlas.
  try {
    await controller.page.evaluate(async () => {
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 250)); }
      window.scrollTo(0, 0);
    });
    await sleep(1500);
  } catch (_) {}

  const photoUrls = (data.city || data.text) ? await scrapeActiveAdPhotos(controller.page) : [];
  if (data.city || data.text) controller.log(`🖼️ Fotos detectadas en la página: ${photoUrls.length}.`);
  if ((data.city || data.text) && photoUrls.length === 0) {
    try {
      const sample = await controller.page.evaluate(() => Array.from(document.querySelectorAll('img'))
        .slice(0, 15).map((i) => i.currentSrc || i.src || i.getAttribute('data-src') || i.getAttribute('data-lazy-src') || '').filter(Boolean));
      controller.log('🔎 imgs en la página: ' + JSON.stringify(sample));
    } catch (_) {}
  }
  let photosPath = '';
  let photosSaved = 0;
  if (photoUrls.length > 0) {
    const targetDir = path.join(__dirname, 'profiles', controller.id, 'photos');
    const tmpDir = targetDir + '.tmp';
    controller.log(`🖼️ Guardando ${photoUrls.length} foto(s)...`);
    const failed = [];
    const hallarBuffer = (u) => {
      if (!photoBuffers || !photoBuffers.size) return null;
      if (photoBuffers.has(u)) return photoBuffers.get(u);
      const tail = String(u).split('/').pop();
      for (const [k, v] of photoBuffers.entries()) { if (k === u || k.split('/').pop() === tail) return v; }
      return null;
    };
    try {
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      for (const url of photoUrls) {
        let saved = null;
        const buf = hallarBuffer(url);
        if (buf) { try { saved = await savePhotoBuffer(buf, tmpDir, controller.id); } catch (_) { saved = null; } }
        if (!saved) saved = await downloadPhotoViaPage(controller.page, url, tmpDir, controller.id);
        if (saved) photosSaved++; else failed.push(url);
      }
    } catch (error) {
      controller.log(`⚠️ Error en la descarga: ${error.message}`);
    }
    if (failed.length) controller.log(`⚠️ ${failed.length} foto(s) no se pudieron guardar.`);

    if (photosSaved > 0) {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const name of fs.readdirSync(targetDir)) {
        try { fs.unlinkSync(path.join(targetDir, name)); } catch (_) {}
      }
      for (const name of fs.readdirSync(tmpDir)) {
        try { fs.renameSync(path.join(tmpDir, name), path.join(targetDir, name)); } catch (_) {}
      }
      photosPath = `profiles/${controller.id}/photos`;
      controller._thumb = undefined;
      controller.log(`🛡️ ${photosSaved} foto(s) blindada(s) en ${photosPath}.`);
    } else {
      controller.log('⚠️ 0 fotos descargadas: se conservan las anteriores.');
    }
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  const config = loadConfig();
  const profile = config.find((x) => x.id === controller.id);
  if (profile) {
    const d = profile.adDetails || {};
    profile.adDetails = {
      name: data.name || d.name || '', headline: data.headline || d.headline || '', city: data.city || d.city || '',
      age: data.age || d.age || '', location: data.location || d.location || '', phone: data.phone || d.phone || '',
      text: data.text || d.text || '', textVariants: d.textVariants || [], headlineVariants: d.headlineVariants || [],
      photosPath: photosPath || d.photosPath || ''
    };
    controller.cfg.adDetails = profile.adDetails;
    saveConfig(config);
  }
  return { ...data, photosPath, photosSaved };
}

app.post('/api/profiles/:id/scrape', async (req, res) => {
  const controller = controllers.get(req.params.id);
  if (!controller || !controller.page) {
    return res.status(400).json({ success: false, error: 'Inicia el navegador de ese perfil para copiar sus datos.' });
  }
  try {
    const photoBuffers = new Map();
    const onResp = (resp) => {
      try {
        const u = resp.url();
        if (/drome6\.com\/imgs\//i.test(u)) resp.buffer().then((b) => { if (b && b.length) photoBuffers.set(u, b); }).catch(() => {});
      } catch (_) {}
    };
    controller.page.on('response', onResp);
    try {
      await controller.page.goto(siteUrls(controller).manage, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(1500);
      res.json({ success: true, data: await scrapeAndSaveAd(controller, photoBuffers) });
    } finally {
      try { controller.page.off('response', onResp); } catch (_) {}
    }
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
    saveConfig(config, { allowEmpty: true });
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

  // Chequeo de seguridad manual (boton "Verificar").
  socket.on('safety-check-now', async (id) => {
    const controller = controllers.get(id);
    if (!controller) return;
    if (!controller.browser) { controller.warn('🛡️ Abre el navegador (Abrir Página) para poder verificar.'); return; }
    const check = await runSafetyCheck(controller).catch(() => null);
    if (check) reportSafetyCheck(controller, check);
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

// --- Control remoto desde la web: la app reporta su estado y ejecuta ordenes ---
async function ejecutarComandoRemoto(cmd) {
  const action = cmd && cmd.action;
  const id = cmd && cmd.profileId;
  if (action === 'update') { await aplicarActualizacion().catch(() => {}); return; }
  const aplicar = (c) => {
    if (action === 'start') c.start();
    else if (action === 'pause') c.pause();
    else if (action === 'resume') { if (c.started) c.resume(); else c.start(); }
    else if (action === 'stop') c.stop();
    else if (action === 'bump') c.publishNow();
  };
  if (id) {
    const c = controllers.get(id);
    if (c) await Promise.resolve(aplicar(c));
  } else {
    for (const c of controllers.values()) { try { await Promise.resolve(aplicar(c)); } catch (_) {} }
  }
}

let autoUpdateAplicado = false;
async function aplicarActualizacion() {
  if (!versionDisponible || !versionDisponible.url) return { ok: false, mensaje: 'No hay actualizacion disponible.' };
  const base = String(licencia.cloudUrl || DEFAULT_CLOUD).replace(/\/+$/, '');
  const full = base + versionDisponible.url;
  const tmp = path.join(os.tmpdir(), `MOMONGA-MEGA-Setup-${versionDisponible.version}.exe`);
  const r = await undiciFetch(full, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('No se pudo descargar la actualizacion (HTTP ' + r.status + ').');
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  require('child_process').spawn(tmp, ['/SILENT', '/CLOSEAPPLICATIONS', '/NORESTART'], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, mensaje: 'Descargada. Instalando actualizacion...' };
}

async function syncConServidor() {
  if (!licencia.token) return;
  try {
    const profiles = [...controllers.values()].map((c) => { const s = controlProfileState(c); delete s.thumb; return s; });
    const r = await undiciFetch(`${licencia.cloudUrl || DEFAULT_CLOUD}/api/app/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: licencia.token, hostname: os.hostname(), version: String(APP_VERSION), profiles }),
    });
    const data = await r.json().catch(() => ({}));
    if (data && Array.isArray(data.commands)) {
      for (const cmd of data.commands) { try { await ejecutarComandoRemoto(cmd); } catch (_) {} }
    }
    // Auto-actualizacion: si el servidor tiene una version mas nueva.
    if (data && Number(data.appVersion) > APP_VERSION && data.appUrl) {
      const antes = versionDisponible && versionDisponible.version;
      versionDisponible = { version: Number(data.appVersion), url: data.appUrl };
      if (antes !== versionDisponible.version) {
        console.log(`🔄 Actualizacion disponible: v${versionDisponible.version}`);
        notify(`🔄 Hay una NUEVA VERSION de MOMONGA MEGA (v${versionDisponible.version}).`).catch(() => {});
      }
      // Actualizacion SILENCIOSA: se descarga e instala sola (una vez por version).
      if (data.autoUpdate !== false && !autoUpdateAplicado) {
        autoUpdateAplicado = true;
        setTimeout(() => { aplicarActualizacion().catch(() => {}); }, 45000);
        console.log(`⏳ Actualizacion automatica programada (v${versionDisponible.version}) en 45s.`);
      }
    }
  } catch (_) {}
}

server.listen(PORT, () => {
  pruneLogs();
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📋 Perfiles cargados: ${controllers.size}`);
  serverLog(`Servidor iniciado en puerto ${PORT} con ${controllers.size} perfil(es).`);
  console.log(`🔑 API de control (para el SaaS): ${CONTROL_API_KEY}`);
  if (!process.env.PANEL_PASSWORD) {
    console.warn('⚠️ Contraseña del panel por defecto: "momonga". Define PANEL_PASSWORD para cambiarla.');
  }
  restoreActiveProfiles();
  refreshTwoCaptchaBalance();
  setInterval(refreshTwoCaptchaBalance, 30 * 60 * 1000).unref();
  setInterval(checkProxiesHealth, 10 * 60 * 1000).unref();
  startTelegramBot();

  // Control remoto desde la web: reporta estado y ejecuta ordenes del cliente.
  syncConServidor().catch(() => {});
  setInterval(() => { syncConServidor().catch(() => {}); }, 5000).unref();

  // Horario de trabajo por perfil: pausa/reanuda segun la hora configurada.
  setInterval(() => {
    for (const c of controllers.values()) {
      const s = c.cfg && c.cfg.schedule;
      if (!s || !s.enabled) continue;
      const activo = dentroHorario(s.from, s.to);
      try {
        if (!activo) {
          if (c.started && !c.paused) { c.log(`⏸️ Fuera de horario (${s.from}–${s.to}): pauso el perfil.`); c.pause(); }
        } else if (c.paused) {
          c.log(`▶️ Dentro de horario (${s.from}–${s.to}): reanudo.`);
          c.resume();
        } else if (!c.started && s.autoStart !== false) {
          c.log(`▶️ Dentro de horario (${s.from}–${s.to}): inicio el perfil.`);
          Promise.resolve(c.start && c.start()).catch(() => {});
        }
      } catch (_) {}
    }
  }, 60 * 1000).unref();
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