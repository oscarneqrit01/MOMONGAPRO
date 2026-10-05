// Genera la version protegida del bot para el instalador:
//   - server.obf.js : server.js OFUSCADO (ilegible / ineditable)
//   - loader.js     : verificador de integridad (hash) + arranque
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const JavaScriptObfuscator = require("./tools/node_modules/javascript-obfuscator");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, "build");
const SRC = path.join(ROOT, "server.js");

const OPCIONES = {
  compact: true,
  target: "node",
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  selfDefending: false,
  simplify: true,
  numbersToExpressions: false,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ["rc4"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersType: "function",
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
  sourceMap: false,
};

function ofuscar(code, opciones) {
  return JavaScriptObfuscator.obfuscate(code, opciones).getObfuscatedCode();
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("Leyendo server.js...");
  const server = fs.readFileSync(SRC, "utf8");

  console.log("Ofuscando server.js (puede tardar)...");
  const inicio = Date.now();
  const obfuscado = ofuscar(server, OPCIONES);
  const payload = path.join(OUT, "server.obf.js");
  fs.writeFileSync(payload, obfuscado);
  console.log(`  -> server.obf.js  (${(obfuscado.length / 1024).toFixed(0)} KB, ${((Date.now() - inicio) / 1000).toFixed(1)}s)`);

  const hash = crypto.createHash("sha256").update(fs.readFileSync(payload)).digest("hex");
  console.log("  hash de integridad:", hash);

  const loader = `const fs=require("fs"),path=require("path"),crypto=require("crypto");
const EXPECTED="${hash}";
const payload=path.join(__dirname,"server.obf.js");
try{
  const buf=fs.readFileSync(payload);
  const hash=crypto.createHash("sha256").update(buf).digest("hex");
  if(hash!==EXPECTED){
    try{const dir=path.join(__dirname,"logs");fs.mkdirSync(dir,{recursive:true});fs.appendFileSync(path.join(dir,"tamper.log"),new Date().toISOString()+" programa alterado (hash no coincide)\\n");}catch(_){}
    console.error("Este programa fue modificado. Contacta a soporte (mimomonga.uk).");
    process.exit(1);
  }
}catch(e){console.error("No se pudo verificar el programa.");process.exit(1);}
require(payload);`;

  console.log("Ofuscando loader de integridad...");
  const loaderObf = ofuscar(loader, OPCIONES);
  fs.writeFileSync(path.join(OUT, "loader.js"), loaderObf);
  console.log("  -> loader.js");

  console.log("\\nListo. Archivos protegidos en instalador\\build\\");
}

main();
