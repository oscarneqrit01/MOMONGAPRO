// Herramienta de licencias (solo para el DESARROLLADOR).
//
//   node license-tools.js keygen
//       Crea keys/private.pem (SECRETA, nunca compartir) y keys/public.pem.
//
//   node license-tools.js machine
//       Muestra el ID de máquina de ESTA PC (el cliente te lo envía).
//
//   node license-tools.js issue --machine <id> --name "Cliente" --days 30
//       Genera license.json firmado para ese cliente (0 días = sin vencimiento).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { machineId } = require('./license');

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIVATE = path.join(KEYS_DIR, 'private.pem');
const PUBLIC = path.join(KEYS_DIR, 'public.pem');

function keygen() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(PUBLIC, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('✅ Claves creadas en keys/.');
  console.log('   - keys/public.pem  → va con el programa (puedes subirla).');
  console.log('   - keys/private.pem → SECRETA. NUNCA la compartas ni la subas.');
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function issue() {
  if (!fs.existsSync(PRIVATE)) {
    console.error('❌ Falta keys/private.pem. Ejecuta primero: node license-tools.js keygen');
    process.exit(1);
  }
  const privateKey = fs.readFileSync(PRIVATE, 'utf8');
  const days = Number(arg('days', '0')) || 0;
  const payload = {
    licenseId: crypto.randomBytes(6).toString('hex'),
    issuedTo: arg('name', 'Cliente'),
    machineId: arg('machine', ''),
    issuedAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400000 : 0
  };
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64');
  const license = { ...payload, signature };
  fs.writeFileSync(path.join(__dirname, 'license.json'), `${JSON.stringify(license, null, 2)}\n`, 'utf8');
  console.log('✅ Licencia generada: license.json');
  console.log(JSON.stringify(payload, null, 2));
}

const cmd = process.argv[2];
if (cmd === 'keygen') keygen();
else if (cmd === 'machine') console.log('ID de máquina:', machineId());
else if (cmd === 'issue') issue();
else {
  console.log('Uso:');
  console.log('  node license-tools.js keygen');
  console.log('  node license-tools.js machine');
  console.log('  node license-tools.js issue --machine <id> --name "Cliente" --days 30');
}
