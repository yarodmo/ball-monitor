/**
 * WhatsApp Publisher Module — Baileys (Multi-Device Protocol)
 *
 * Conecta como "dispositivo vinculado" del número admin (igual que WhatsApp Web).
 * Postea imagen + caption a un grupo donde el admin es miembro.
 *
 * Setup inicial: ejecutar `node tools/whatsapp-setup.js` desde el VPS,
 * escanear el QR con el número admin (1 sola vez). La sesión persiste en
 * ../auth-state/baileys/.
 */

const fs = require("fs");
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("@whiskeysockets/baileys");
const P = require("pino");

const AUTH_DIR = path.join(__dirname, "../auth-state/baileys");
const CONNECT_TIMEOUT_MS = 180000; // 3 minutos (tiempo holgado para QR scan + restart)

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [whatsapp] ${msg}`;
  console.log(line);
  const logFile = path.join(__dirname, "../logs/monitor.log");
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (_) { }
}

const BAILEYS_LOGGER = P({ level: "silent" });

let sock = null;
let connectionReady = false;
let connectingPromise = null;

async function getSocket({ printQR = false } = {}) {
  if (sock && connectionReady) return sock;
  if (connectingPromise) return connectingPromise;

  connectingPromise = connectInternal({ printQR });

  try {
    const result = await connectingPromise;
    return result;
  } catch (e) {
    connectingPromise = null;
    throw e;
  }
}

async function connectInternal({ printQR }) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  let settled = false;

  const overallTimeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectFn(new Error(`WhatsApp connection timeout (${CONNECT_TIMEOUT_MS / 1000}s) — sesión no autenticada?`));
    }
  }, CONNECT_TIMEOUT_MS);

  const finish = (result, error) => {
    if (settled) return;
    settled = true;
    clearTimeout(overallTimeout);
    if (error) rejectFn(error);
    else resolveFn(result);
  };

  const attemptConnect = () => {
    sock = makeWASocket({
      auth: state,
      logger: BAILEYS_LOGGER,
      browser: Browsers.appropriate("Ballbot Monitor"),
      printQRInTerminal: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && printQR) {
        const qrcode = require("qrcode-terminal");
        log("📱 Escanea este QR con el WhatsApp del número admin:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        connectionReady = true;
        log(`✅ WhatsApp conectado (${sock.user?.id || "?"})`);
        finish(sock);
        return;
      }

      if (connection === "close") {
        connectionReady = false;
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.restartRequired) {
          log(`🔄 Restart required (code=515) — reiniciando socket automáticamente...`);
          sock = null;
          setTimeout(attemptConnect, 1500);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          log(`❌ Logged out (code=401) — borra auth-state/baileys/ y vuelve a escanear el QR`);
          sock = null;
          finish(null, new Error("WhatsApp logged out — re-auth requerido"));
          return;
        }

        // Cualquier otro disconnect: reintentar con backoff suave
        log(`⚠️  Desconectado (code=${code}) — reintentando en 3s...`);
        sock = null;
        if (!settled) {
          setTimeout(attemptConnect, 3000);
        }
      }
    });
  };

  attemptConnect();
  return promise;
}

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
