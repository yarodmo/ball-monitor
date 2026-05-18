/**
 * WhatsApp Publisher Module — Baileys (Multi-Device Protocol)
 *
 * Conecta como "dispositivo vinculado" del número admin (igual que WhatsApp Web).
 * Postea imagen + caption a un grupo donde el admin es miembro.
 *
 * Setup inicial: ejecutar `node tools/whatsapp-setup.js` desde el VPS,
 * escanear el QR con el número admin (1 sola vez). La sesión persiste en
 * ../auth-state/baileys/.
 *
 * Interfaz: postToWhatsApp(imageBuffer, caption) — espejo de postToTelegram().
 */

const fs = require("fs");
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const P = require("pino");

const AUTH_DIR = path.join(__dirname, "../auth-state/baileys");

// ─── Logger ──────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [whatsapp] ${msg}`;
  console.log(line);
  const logFile = path.join(__dirname, "../logs/monitor.log");
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (_) { }
}

// Silenciar el logger interno de Baileys (muy ruidoso)
const BAILEYS_LOGGER = P({ level: "silent" });

// ─── Singleton de conexión ───────────────────────────────────────────────────
let sock = null;
let connectionReady = false;
let connectingPromise = null;

async function getSocket({ printQR = false } = {}) {
  if (sock && connectionReady) return sock;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: BAILEYS_LOGGER,
      browser: Browsers.appropriate("Ballbot Monitor"),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WhatsApp connection timeout (60s) — sesión no autenticada?"));
      }, 60000);

      sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && printQR) {
          const qrcode = require("qrcode-terminal");
          log("📱 Escanea este QR con el WhatsApp del número admin:");
          qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
          clearTimeout(timeout);
          connectionReady = true;
          log(`✅ WhatsApp conectado (${sock.user?.id || "?"})`);
          resolve(sock);
        }

        if (connection === "close") {
          connectionReady = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = code !== DisconnectReason.loggedOut;
          log(`⚠️  WhatsApp desconectado (code=${code}) — ${shouldReconnect ? "reconectando..." : "logged out, requiere re-QR"}`);
          sock = null;
          connectingPromise = null;
          if (!shouldReconnect) {
            clearTimeout(timeout);
            reject(new Error("WhatsApp logged out — corre tools/whatsapp-setup.js"));
          }
        }
      });
    });
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

// ─── API pública ─────────────────────────────────────────────────────────────
async function postToWhatsApp(imageBuffer, caption) {
  const groupId = process.env.WHATSAPP_GROUP_ID;
  if (!groupId) {
    log("⏭️  WhatsApp: no configurado (WHATSAPP_GROUP_ID faltante)");
    return null;
  }

  try {
    const socket = await getSocket();
    const result = await socket.sendMessage(groupId, {
      image: imageBuffer,
      caption,
    });
    log(`✅ WhatsApp publicado: group=${groupId} msgId=${result?.key?.id}`);
    return result;
  } catch (e) {
    log(`❌ WhatsApp error: ${e.message}`);
    return null;
  }
}

module.exports = { postToWhatsApp, getSocket };
