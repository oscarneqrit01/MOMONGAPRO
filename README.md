# MOMONGA PRO

Panel multi-perfil para automatizar **bumps** y **reposts** en sitios tipo MegaPersonals, usando Chrome controlado con Puppeteer, proxies aislados por perfil, resolución automática de captcha, detección de bloqueos y estadísticas en vivo.

---

## Características

- **Multi-perfil**: cada perfil usa su propio `user-data-dir`, proxy y huella (zona horaria, idioma, geolocalización).
- **Proxy blindado**: el proxy se aplica en Chrome (`--proxy-server` + `page.authenticate`) y también en la descarga de fotos (vía `undici` `ProxyAgent`), para no exponer la IP local.
- **Validación de proxy** antes de arrancar: si el proxy no responde, no se lanza el perfil (no se gastan ciclos).
- **Captcha**: resolución automática de reCAPTCHA (v2/v3) y de captchas de imagen con 2Captcha. Si no puede resolverlo, espera la entrada manual.
- **Bump / Delete & Repost**: ciclos automáticos configurables por intervalo.
- **Auto-repost**: borra y republica cada N horas.
- **Copia de anuncio**: extrae ciudad/edad/texto y descarga+limpia las fotos del anuncio actual (quita EXIF y altera ligeramente la imagen).
- **Parada de emergencia**: si detecta señales de suspensión/bloqueo en cualquier perfil, detiene todos los perfiles.
- **Apelaciones**: al detectar un bloqueo guarda evidencia (captura, HTML, mensaje, URL, perfil y paso) en `logs/appeals/`, genera un borrador de apelación en inglés y, si el navegador tiene `supportEmail`, **abre el correo (Outlook) automáticamente** con el texto listo. En el panel puedes ver, **descargar o copiar la captura**, **abrir la carpeta de evidencias** y **enviar por correo**, ya que el formulario del sitio puede no permitir adjuntar archivos.
- **Auto-arranque (opcional)**: con `AUTO_START=1`, al reiniciar el servidor reanuda los perfiles que estaban activos. Por defecto está **desactivado**.
- **Panel web** en tiempo real (Socket.IO): **Abrir Página** / Iniciar / Pausar / Detener / Publicar, contadores, estado y registro en vivo. "Abrir Página" solo abre el navegador; el conteo empieza únicamente al pulsar **Iniciar**.
- **Estadísticas**: bumps de hoy, total y último bump.
- **Logs a archivo** diarios con rotación (no se pierden al cerrar la terminal).
- **Notificaciones** por Telegram y/o Discord ante fallos y paradas de emergencia.
- **Detección automática de Chrome** (Windows/macOS/Linux) o navegador propio de Puppeteer.

---

## Requisitos

- **Node.js 18+** (recomendado LTS)
- **Google Chrome** (o Chromium) instalado
- Una **API Key de 2Captcha** (opcional, para captchas)

---

## Instalación

```bash
git clone https://github.com/oscarneqrit01/MOMONGAPRO.git
cd MOMONGAPRO
npm install
```

Crea tu configuración a partir de la plantilla:

```bash
copy config.example.json config.json    # Windows
cp config.example.json config.json      # macOS/Linux
```

Edita `config.json` con tus perfiles (ver abajo).

---

## Uso

```bash
node server.js
```

O con el lanzador de Windows: **`iniciar.bat`**.

Luego abre el panel en el navegador:

```
http://localhost:3000
```

Introduce la contraseña del panel (por defecto `momonga`; cámbiala con la variable `PANEL_PASSWORD`).

## Prueba local sin cuenta real

Para probar el ciclo completo sin usar MegaPersonals, ejecuta `probar-local.bat`. Levanta un sitio simulado en `127.0.0.1:4100` y el panel en `http://localhost:3001` usando `config.test.json`.

La prueba incluye lista de anuncios, bump, página `success_publish`, retorno a `My Posts` y formulario de republicación. No usa credenciales, proxies ni `config.json` real.

---

## Actualizar en otra PC

Para traer las últimas mejoras en otra máquina donde ya clonaste el repositorio:

```bash
git pull
npm install
```

En Windows puedes usar el lanzador **`actualizar.bat`** (hace `git pull` + `npm install` con doble clic).

> Tus datos locales (`config.json`, `profiles/`, `state.json`, `logs/`) **no** se modifican al actualizar, porque están en `.gitignore`.

---

## Configuración (`config.json`)

Es un **array** de perfiles:

```json
[
  {
    "id": "PerfilEjemplo",
    "port": 9333,
    "apiKey2Captcha": "TU_CLAVE",
    "email": "tu@email.com",
    "password": "tu_password",
    "intervalMinutes": 16,
    "url": "https://megapersonals.eu/",
    "adDetails": {
      "name": "None",
      "headline": "Título del anuncio",
      "city": "Montreal",
      "age": "25",
      "location": "Ashley Heights",
      "phone": "7633218082",
      "text": "Texto del anuncio",
      "photosPath": "profiles/PerfilEjemplo/photos"
    },
    "proxy": {
      "host": "IP_DEL_PROXY",
      "port": 12345,
      "username": "USUARIO",
      "password": "CONTRASENA"
    },
    "settings": {
      "rotateAds": false,
      "randomizedDelay": true,
      "publishOnStart": true
    },
    "autoRepostActive": false,
    "repostInterval": 6
  }
]
```

| Campo | Descripción |
|---|---|
| `id` | Nombre único del perfil (también nombra la carpeta de sesión). |
| `port` | Puerto de depuración remota de Chrome (único por perfil). |
| `apiKey2Captcha` | Clave de 2Captcha. |
| `email` / `password` | Credenciales de login del sitio. |
| `intervalMinutes` | Minutos entre bumps. |
| `url` | Página inicial. |
| `supportEmail` | (Opcional) Correo de soporte del sitio. Por defecto `support@megapersonals.eu`. Al detectar un bloqueo se abre el correo (Outlook) con la apelación lista. |
| `supportUrl` | (Opcional) URL de contacto/soporte del sitio para apelaciones. Por defecto `<sitio>/contact`. |
| `adDetails` | Ciudad, edad, texto y carpeta de fotos del anuncio. |
| `proxy` | Proxy HTTP del perfil. |
| `settings.rotateAds` | Si está activo, en cada ciclo hace **bump de los anuncios de la cuenta uno por uno** (rota entre todos, sin borrar). |
| `settings.randomizedDelay` | Añade ±20% de variación al intervalo. |
| `settings.publishOnStart` | Publica al pulsar Iniciar. |
| `autoRepostActive` / `repostInterval` | Ciclo automático de borrado+republicación cada N horas. |

> **Importante:** `config.json`, `state.json`, `profiles/` y `logs/` están en `.gitignore` y **no** se suben al repositorio (contienen datos sensibles y locales de cada máquina).

---

## Variables de entorno

| Variable | Descripción | Por defecto |
|---|---|---|
| `PANEL_PASSWORD` | Contraseña del panel web (inicial; se puede cambiar desde el panel). | `momonga` |
| `PANEL_AUTH_PATH` | Ruta del archivo donde se guarda la contraseña del panel (hash). | `panel-auth.json` |
| `PORT` | Puerto del servidor. | `3000` |
| `AUTO_START` | `1` activa el auto-arranque de perfiles al iniciar. | desactivado |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram. | — |
| `TELEGRAM_CHAT_ID` | Chat/ID de destino en Telegram. | — |
| `DISCORD_WEBHOOK_URL` | URL de webhook de Discord. | — |
| `CHROME_BIN` | Ruta manual a Chrome (si la detección falla). | autodetectado |

En Windows puedes definirlas en `iniciar.bat`, por ejemplo:

```bat
set PANEL_PASSWORD=tu_clave_segura
set DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

---

## Logs

La actividad se guarda en `logs/AAAA-MM-DD.log` (uno por día) y se rotan conservando los últimos 30 días.

---

## Estructura del proyecto

```
MOMONGAPRO/
├── server.js            # Servidor + automatización (Express, Socket.IO, Puppeteer)
├── public/
│   └── index.html       # Panel web (diseño y lógica del cliente)
├── config.example.json  # Plantilla de configuración
├── iniciar.bat          # Lanzador de Windows
├── package.json
├── logs/                # (generado) registros diarios
├── profiles/            # (generado) sesiones de Chrome por perfil
├── panel-auth.json      # (generado) hash de la contraseña del panel
├── state.json           # (generado) estado y estadísticas
└── .gitignore
```

---

## Seguridad

- El panel requiere contraseña (`PANEL_PASSWORD`); se protege HTTP y Socket.IO.
- La contraseña se puede cambiar desde el panel con el botón **Cambiar contraseña**. Se guarda como hash (scrypt + salt) en `panel-auth.json`, nunca en texto plano.
- `config.json`, `panel-auth.json` y `state.json` con proxies y claves **nunca** se suben al repositorio.
- No ejecutes dos instancias a la vez: comparten `state.json` y las carpetas de perfiles.

---

## Licencia

Uso privado. Úsalo bajo tu responsabilidad y respetando los términos del sitio objetivo.
