// Lanzador ÚNICO: arranca Mongo + Bot + SaaS + Frontend + Túnel en UNA sola ventana.
// Todo sale en esta consola; Ctrl+C apaga todo. (No abre 5 ventanas.)
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const root = __dirname;
const isWin = process.platform === 'win32';

const puertoLibre = (p) => new Promise((resolve) => {
  const s = net.connect({ port: p, host: '127.0.0.1' });
  let listo = false;
  const fin = (libre) => { if (listo) return; listo = true; try { s.destroy(); } catch (_) {} resolve(libre); };
  s.once('connect', () => fin(false));   // conectó -> ocupado
  s.once('error', () => fin(true));      // error -> libre
  setTimeout(() => fin(true), 1500);
});

const existe = (f) => { try { return fs.existsSync(f); } catch (_) { return false; } };

const cloudflaredCorriendo = () => {
  try {
    const out = execSync('tasklist /FI "imagename eq cloudflared.exe"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return /cloudflared\.exe/i.test(out);
  } catch (_) { return false; }
};

const servicios = [
  {
    nombre: 'Mongo', puerto: 27017,
    cmd: path.join(root, 'renta', 'backend', 'mongo7', 'mongodb-win32-x86_64-windows-7.0.24', 'bin', 'mongod.exe'),
    args: ['--dbpath', path.join(root, 'renta', 'backend', 'data', 'db'), '--port', '27017', '--bind_ip', '127.0.0.1',
      '--logpath', path.join(root, 'renta', 'backend', 'data', 'mongo70.log'), '--logappend'],
    cwd: root,
  },
  {
    nombre: 'Bot', puerto: 3100,
    cmd: process.execPath, args: ['server.js'], cwd: root,
    env: { PORT: '3100', PANEL_PASSWORD: 'momonga' },
  },
  {
    nombre: 'SaaS', puerto: 4000,
    cmd: process.execPath, args: ['supervisor.js'], cwd: path.join(root, 'renta', 'backend'),
  },
  {
    nombre: 'Frontend', puerto: 3000,
    cmd: process.execPath, args: [path.join('node_modules', 'vite', 'bin', 'vite.js')], cwd: path.join(root, 'renta', 'frontend'),
  },
  {
    nombre: 'Tunel', puerto: 0,
    cmd: path.join(root, 'cloudflared.exe'),
    args: ['tunnel', '--config', path.join(root, '.cloudflared', 'config.yml'), 'run'], cwd: root,
  },
];

const hijos = [];
const color = { Mongo: '\x1b[32m', Bot: '\x1b[36m', SaaS: '\x1b[35m', Frontend: '\x1b[33m', Tunel: '\x1b[34m' };

const prefijoLinea = (nombre) => {
  const p = `[${nombre}] `;
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linea = buffer.slice(0, i + 1);
      buffer = buffer.slice(i + 1);
      process.stdout.write((color[nombre] || '') + p + '\x1b[0m' + linea);
    }
    if (buffer.length > 4000) { process.stdout.write((color[nombre] || '') + p + '\x1b[0m' + buffer); buffer = ''; }
  };
};

const arrancar = (s) => {
  if (s.cmd && !existe(s.cmd)) {
    console.log(`⚠️  [${s.nombre}] no se encontró: ${s.cmd} — se omite.`);
    return;
  }
  const child = spawn(s.cmd, s.args, {
    cwd: s.cwd,
    env: { ...process.env, ...(s.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = prefijoLinea(s.nombre);
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('exit', (code) => console.log(`🔚 [${s.nombre}] salió (código ${code}).`));
  hijos.push({ s, child });
  console.log(`▶️  [${s.nombre}] iniciado (PID ${child.pid}).`);
};

const matarTodo = () => {
  for (const { child } of hijos) {
    try {
      if (isWin) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch (_) {}
  }
};

(async () => {
  console.log('==========================================');
  console.log('   MOMONGA PRO + Renta  (una sola ventana)');
  console.log('==========================================');
  for (const s of servicios) {
    if (s.puerto && !(await puertoLibre(s.puerto))) {
      console.log(`ℹ️  [${s.nombre}] el puerto ${s.puerto} ya está en uso — se omite (ya corre).`);
      continue;
    }
    if (s.nombre === 'Tunel' && cloudflaredCorriendo()) {
      console.log('ℹ️  [Tunel] cloudflared ya está corriendo — se omite.');
      continue;
    }
    arrancar(s);
    await new Promise((r) => setTimeout(r, s.nombre === 'Mongo' ? 3000 : 1200));
  }
  console.log('\n✅ Todo arrancado. Esta es la ÚNICA ventana. Pulsa Ctrl+C para apagar todo.\n');
})();

process.on('SIGINT', () => { console.log('\n🛑 Apagando todo...'); matarTodo(); process.exit(0); });
process.on('SIGTERM', () => { matarTodo(); process.exit(0); });
process.on('exit', () => { matarTodo(); });
