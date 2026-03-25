# 🎱 Florida Lottery YouTube Monitor

Monitorea el canal oficial de Florida Lottery en YouTube, captura frames
de cada video de resultados y envía un email inmediatamente.

**Canal monitoreado:** https://www.youtube.com/channel/UCPm7mcdzUK9PjQtdGX4_Niw

---

## ¿Cómo funciona?

```
YouTube RSS Feed (cada 2 min)
       │
       ▼
¿Video nuevo de Pick 3/4?
       │ SÍ
       ▼
yt-dlp descarga thumbnail/frame
       │
       ▼
Nodemailer envía email con imagen
a 2ballbot@gmail.com
```

> **Sin API key de YouTube.** Usa el feed RSS público del canal — nativo,
> gratuito, sin límites de quota.

---

## Setup en VPS (Ubuntu/Debian)

```bash
# 1. Clonar / subir el proyecto
scp -r lottery-monitor/ user@tu-vps:/home/user/

# 2. En el VPS
cd lottery-monitor
bash setup.sh

# 3. Configurar credenciales
nano config/config.json
```

### config/config.json — campos a completar

| Campo | Valor |
|-------|-------|
| `smtp.user` | Tu Gmail (ej: `tubot@gmail.com`) |
| `smtp.pass` | App Password de Google (16 chars) |
| `recipients` | Lista de emails destino |
| `poll_interval_ms` | `120000` = cada 2 min (recomendado) |

### Cómo obtener Gmail App Password

1. Ir a https://myaccount.google.com/security
2. Activar **Verificación en 2 pasos**
3. Ir a **Contraseñas de aplicación**
4. Crear una nueva → copiar los 16 caracteres
5. Pegar en `smtp.pass`

---

## Iniciar el servicio

```bash
# Iniciar con PM2 (se reinicia solo si cae)
npm run pm2:start

# Ver estado
npm run pm2:status

# Ver logs en tiempo real
npm run pm2:logs

# Ver estado via HTTP
curl http://localhost:3456 | python3 -m json.tool

# Reiniciar
npm run pm2:restart

# Que arranque automáticamente al reiniciar el VPS
pm2 startup
pm2 save
```

---

## Estructura del proyecto

```
lottery-monitor/
├── src/
│   └── monitor.js        # Servicio principal
├── config/
│   ├── config.json       # Credenciales y configuración
│   └── state.json        # IDs procesados (auto-generado)
├── captures/             # Screenshots capturados
├── logs/
│   └── monitor.log       # Log histórico
├── package.json
├── setup.sh              # Script de instalación
└── README.md
```

---

## Sorteos monitoreados

| Draw | Horario ET |
|------|-----------|
| Pick 3 Midday | ~12:30 PM |
| Pick 3 Evening | ~7:57 PM |
| Pick 4 Midday | ~12:30 PM |
| Pick 4 Evening | ~7:57 PM |

Florida Lottery suele publicar el video en YouTube pocos minutos después
del sorteo. El monitor detecta el nuevo video en el siguiente ciclo de
polling (máx 2 minutos de retraso).

---

## Troubleshooting

**El email no llega**
- Verifica el App Password (no es tu contraseña normal de Gmail)
- Revisa logs: `npm run pm2:logs`
- Prueba SMTP: `node -e "require('./src/monitor.js')"` (comentar el setInterval)

**yt-dlp falla**
- Actualizar: `sudo yt-dlp -U`
- El sistema hace fallback a thumbnail estático si falla el video

**El feed no detecta videos nuevos**
- YouTube puede tardar 5-15 min en actualizar el RSS después de publicar
- Intervalo actual: configurable en `poll_interval_ms`

---

## Dependencias del sistema

| Tool | Propósito |
|------|-----------|
| Node.js 20+ | Runtime principal |
| yt-dlp | Descarga thumbnails/frames |
| ffmpeg | Extracción de frames de video |
| PM2 | Process manager (keep-alive) |
