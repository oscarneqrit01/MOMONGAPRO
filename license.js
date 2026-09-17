// Sistema de licencias OFFLINE (sin servidor).
// - El desarrollador genera un par de claves (license-tools.js keygen).
// - La clave privada NUNCA se comparte; la pública va con el programa.
// - Cada licencia se firma y va atada a la máquina y con vencimiento.
// - En la PC del desarrollador se salta con MOMONGA_DEV=1 o un archivo DEV.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEV_FILE = path.join(__dirname, 'DEV');

function licensePath() {
  return process.env.LICENSE_PATH || path.join(__dirname, 'license.json');
}

function publicKeyPath() {
  return process.env.LICENSE_PUBLIC_KEY_PATH || path.join(__dirname, 'keys', 'public.pem');
}

function machineId() {
  const parts = [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model || ''];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        parts.push(net.mac);
        break;
      }
    }
    if (parts.length > 4) break;
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}

function loadPublicKey() {
  if (process.env.LICENSE_PUBLIC_KEY) return process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n');
  try { return fs.readFileSync(publicKeyPath(), 'utf8'); } catch (_) { return null; }
}

function isDev() {
  return process.env.MOMONGA_DEV === '1' || fs.existsSync(DEV_FILE);
}

function check() {
  // La PC del desarrollador nunca se bloquea.
  if (isDev()) return { valid: true, mode: 'dev' };

  const publicKey = loadPublicKey();
  if (!publicKey) {
    // Sin clave configurada todavía: no bloquear (evita dejar fuera al dueño).
    return { valid: true, mode: 'unconfigured', warning: 'No hay clave pública de licencia configurada.' };
  }

  let lic;
  try {
    lic = JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
  } catch (_) {
    return { valid: false, reason: 'No se encontró license.json o es inválido.' };
  }

  const { signature, ...payload } = lic;
  if (!signature) return { valid: false, reason: 'La licencia no tiene firma.' };

  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, 'base64'));
  } catch (_) {
    ok = false;
  }
  if (!ok) return { valid: false, reason: 'La firma de la licencia no es válida.' };

  if (payload.machineId && payload.machineId !== machineId()) {
    return { valid: false, reason: 'La licencia es para otra máquina.' };
  }

  if (payload.expiresAt && Date.now() > Number(payload.expiresAt)) {
    return { valid: false, reason: 'La licencia venció.' };
  }

  return { valid: true, mode: 'licensed', license: payload };
}

module.exports = { machineId, check, isDev, licensePath, publicKeyPath };
