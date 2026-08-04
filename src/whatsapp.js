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
 * Lazy reconnect: tras una desconexión steady-state (post-init), se invalida
 * todo el estado del singleton. El siguiente postToWhatsApp() reconecta
 * transparente con las creds del disco — ~1-3s en el peor caso, invisible
 * al usuario porque corre en paralelo con Instagram (~7s, siempre más lento).
 */

const fs = require("fs");
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const P = require("pino");

const AUTH_DIR = path.join(__dirname, "../auth-state/baileys");
const CONNECT_TIMEOUT_MS = 180000; // 3 minutos (holgado para QR scan + restart)

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

/**
 * Limpia TODO el estado del singleton. Se llama tras cualquier desconexión
 * no-loggedOut. Forza al próximo getSocket() a crear conexión fresca con
 * las creds del disco. ESTE FIX RESUELVE el zombie state que dejaba a
 * connectingPromise apuntando a un sock muerto post-disconnect.
 */
function resetConnectionState() {
  sock = null;
  connectionReady = false;
  connectingPromise = null;
}

async function getSocket({ printQR = false } = {}) {
  if (sock && connectionReady) return sock;
  if (connectingPromise) return connectingPromise;

  connectingPromise = connectInternal({ printQR });

  try {
    return await connectingPromise;
  } catch (e) {
    resetConnectionState();
    throw e;
  }
}

async function connectInternal({ printQR }) {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // WhatsApp impone una versión MÍNIMA de cliente. Si la que manda Baileys se
  // queda atrás, el handshake muere con code=405 ANTES de autenticar — no es
  // sesión caducada y re-escanear el QR no arregla nada.
  // Incidente 2026-07-29: WA cortó por versión, Baileys publicó rc14 para
  // adaptarse y esta instalación (clavada en rc11) quedó rechazada 6 días en
  // silencio. Resolver la versión en cada conexión hace que el próximo corte
  // se auto-cure en vez de repetir el apagón.
  let waVersion = null;
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    waVersion = version;
    log(`📌 WA client version: ${version.join(".")}${isLatest ? " (latest)" : " (fallback de la librería)"}`);
  } catch (e) {
    log(`⚠️  No se pudo resolver WA version (${e.message}) — usando la de la librería`);
  }

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
    const sockConfig = {
      auth: state,
      logger: BAILEYS_LOGGER,
      browser: Browsers.appropriate("Ballbot Monitor"),
      printQRInTerminal: false,
    };
    // Solo si se resolvió: pasar version=undefined pisaría el default de la librería.
    if (waVersion) sockConfig.version = waVersion;
    sock = makeWASocket(sockConfig);

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

        // Logged out: terminal, requiere re-QR manual
        if (code === DisconnectReason.loggedOut) {
          log(`❌ Logged out (code=401) — borra auth-state/baileys/ y re-escanea QR`);
          resetConnectionState();
          finish(null, new Error("WhatsApp logged out — re-auth requerido"));
          return;
        }

        // Conexión inicial todavía en progreso: re-intentar dentro de la misma promesa
        // Cubre code 515 (restartRequired) post-QR-scan + otros transitorios al inicio
        if (!settled) {
          const delayMs = code === DisconnectReason.restartRequired ? 1500 : 3000;
          log(`🔄 Reintento durante init (code=${code}) — en ${delayMs / 1000}s...`);
          sock = null;
          setTimeout(attemptConnect, delayMs);
          return;
        }

        // Desconexión steady-state (post-init): invalidar singleton para lazy reconnect.
        // La próxima llamada a getSocket() creará una conexión fresca con las creds del disco.
        log(`⚠️  Desconectado (code=${code}) — invalidando singleton. Próximo envío reconectará.`);
        resetConnectionState();
      }
    });
  };

  attemptConnect();
  return promise;
}

/**
 * Publica imagen + caption al grupo de WhatsApp.
 *
 * Capa de defensa adicional: si sendMessage falla con "Connection Closed"
 * (race condition entre getSocket() y sendMessage()), invalida el cache
 * y reintenta UNA vez con conexión fresca.
 */
async function postToWhatsApp(imageBuffer, caption) {
  const groupId = process.env.WHATSAPP_GROUP_ID;
  if (!groupId) {
    log("⏭️  WhatsApp: no configurado (WHATSAPP_GROUP_ID faltante)");
    return null;
  }

  const attemptSend = async () => {
    const socket = await getSocket();
    return socket.sendMessage(groupId, { image: imageBuffer, caption });
  };

  try {
    const result = await attemptSend();
    log(`✅ WhatsApp publicado: group=${groupId} msgId=${result?.key?.id}`);
    return result;
  } catch (e) {
    // Reintento único si la conexión murió entre getSocket y sendMessage
    if (/Connection Closed|Connection Terminated|Stream Errored/i.test(e.message || "")) {
      log(`⚠️  Conexión muerta detectada en send (${e.message}) — invalidando y reintentando...`);
      resetConnectionState();
      try {
        const result = await attemptSend();
        log(`✅ WhatsApp publicado (post-retry): group=${groupId} msgId=${result?.key?.id}`);
        return result;
      } catch (e2) {
        log(`❌ WhatsApp error post-retry: ${e2.message}`);
        return null;
      }
    }
    log(`❌ WhatsApp error: ${e.message}`);
    return null;
  }
}

module.exports = { postToWhatsApp, getSocket };
