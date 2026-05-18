/**
 * Social Publisher Module — Ballbot Hit Notifications
 * Generates branded PNG images and publishes to Meta platforms.
 *
 * Design: Mirrors the email template exactly (dark bg, gold numbers,
 * sun/moon emoji, audit badge). Same cognitive flow for subscribers
 * who see results in both email and social feeds.
 *
 * Interface: publishToSocial({ drawInfo, extractedNumbers })
 * Designed to be called at the same level as sendEmail() in monitor.js.
 *
 * Future: This module can be imported by other ecosystem services
 * (e.g., Telegram bot admin "Publicar" button) without modification.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// ─── Config ──────────────────────────────────────────────────────────────────
// Loaded from environment variables (set in .env)
const META_CONFIG = {
  pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  pageId: process.env.META_PAGE_ID || "",
  igUserId: process.env.META_IG_USER_ID || "",
  groupId: process.env.META_GROUP_ID || "",
  ctaUrl: process.env.BALLBOT_CTA_URL || "https://app.ballbot.tel",
  ctaText: process.env.BALLBOT_CTA_TEXT || "Estrategias en tiempo real → app.ballbot.tel",
};

const TELEGRAM_CONFIG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  channelId: process.env.TELEGRAM_CHANNEL_ID || "@BallBotme",
};

// ─── Logger (reuse monitor's pattern) ────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [social] ${msg}`;
  console.log(line);
  const logFile = path.join(__dirname, "../logs/monitor.log");
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch (_) { }
}

// ─── SVG Template → PNG Image Generation ─────────────────────────────────────
/**
 * Generates a 1080x1080 PNG (Instagram-optimal) matching the email design.
 * Uses Sharp's SVG-to-PNG pipeline — no native canvas dependencies.
 *
 * @param {object} params
 * @param {string} params.p3 - Pick 3 numbers (e.g., "585")
 * @param {string} params.p4 - Pick 4 numbers (e.g., "1375")
 * @param {string} params.type - Draw type (e.g., "Pick Evening")
 * @param {string} params.emoji - Period emoji ("🌙" or "☀️")
 * @param {string} params.date - Formatted date string
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function generateHitImage({ p3, p4, type, emoji, date }) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    throw new Error(
      "Sharp is required for image generation. Install it: npm install sharp"
    );
  }

  const SIZE = 1080;
  const p3Str = p3 || "???";
  const p4Str = p4 || "????";
  const timeNow = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const dateStr = date || new Date().toLocaleDateString("es-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Emoji as text in SVG — unicode sun/moon renders well
  const emojiChar = emoji === "☀️" ? "☀" : "🌙";

  const svg = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background base gradient: deep navy -->
    <radialGradient id="bgGlow" cx="50%" cy="50%" r="70%">
      <stop offset="0%" style="stop-color:#14244B;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#080E21;stop-opacity:1"/>
    </radialGradient>

    <!-- Geometric Grid Pattern -->
    <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
      <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#FFFFFF" stroke-width="1" opacity="0.04"/>
    </pattern>

    <!-- Frosted glass card gradient -->
    <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#ffffff;stop-opacity:0.12"/>
      <stop offset="100%" style="stop-color:#ffffff;stop-opacity:0.02"/>
    </linearGradient>

    <!-- CTA pill gradient: golden -->
    <linearGradient id="ctaGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" style="stop-color:#F9A826"/>
      <stop offset="100%" style="stop-color:#FFD700"/>
    </linearGradient>

    <!-- Golden glow for numbers -->
    <filter id="goldGlow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>

    <!-- Soft drop shadow for cards -->
    <filter id="softShadow" x="-15%" y="-15%" width="130%" height="130%">
      <feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#000000" flood-opacity="0.6"/>
    </filter>

    <clipPath id="rounded">
      <rect width="${SIZE}" height="${SIZE}" rx="32"/>
    </clipPath>
  </defs>

  <g clip-path="url(#rounded)">

    <!-- ══ BACKGROUND ══ -->
    <!-- Deep Navy Base -->
    <rect width="${SIZE}" height="${SIZE}" fill="url(#bgGlow)"/>
    <!-- Soft background glow only (grid removed for cleaner cognitive flow) -->

    <!-- ══ HEADER BAR ══ -->
    <!-- Accent line at top instead of full bar -->
    <line x1="0" y1="180" x2="${SIZE}" y2="180" stroke="#00E5FF" stroke-width="1" opacity="0.3"/>

    <!-- Brand: Pure Typography (No Icon) - APEX Bold -->
    <text x="540" y="90" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="56" font-weight="900" letter-spacing="8">
      <tspan fill="#FFFFFF">BALLBOT </tspan>
      <tspan fill="#FFD700">HIT</tspan>
    </text>

    <!-- Subtitle -->
    <text x="540" y="145" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="24" font-weight="500" letter-spacing="6"
          fill="#00E5FF" opacity="0.9">
      ${type.toUpperCase()} — RESULTADOS OFICIALES
    </text>

    <!-- ══ FROSTED GLASS DATA CARDS ══ -->
    <!-- Card 1: Pick 3 -->
    <rect x="90" y="240" width="410" height="320" rx="24"
          fill="url(#cardGrad)" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.15"
          filter="url(#softShadow)"/>
    <text x="295" y="300" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="24" font-weight="600" letter-spacing="6"
          fill="#A0C4FF">PICK 3</text>
    <!-- Golden number (crisp) -->
    <text x="295" y="470" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="140" font-weight="800"
          fill="#FFD700">${p3Str}</text>

    <!-- Card 2: Pick 4 -->
    <rect x="580" y="240" width="410" height="320" rx="24"
          fill="url(#cardGrad)" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.15"
          filter="url(#softShadow)"/>
    <text x="785" y="300" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="24" font-weight="600" letter-spacing="6"
          fill="#A0C4FF">PICK 4</text>
    <!-- Golden number (crisp) -->
    <text x="785" y="470" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="120" font-weight="800"
          fill="#FFD700">${p4Str}</text>

    <!-- ══ VERIFICATION STRIP ══ -->
    <!-- Institutional verification without the black error box -->
    <g transform="translate(540, 633)">
      <circle cx="-230" cy="-2" r="14" fill="#2E7D52" />
      <path d="M -235 -2 L -232 1 L -225 -6" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="-205" y="5" text-anchor="start"
            font-family="'Segoe UI','Roboto',Arial,sans-serif"
            font-size="22" font-weight="400" font-style="italic" letter-spacing="1"
            fill="#B0C4DE">
        Verificado por IA · Sincronizado en tiempo real
      </text>
    </g>

    <!-- ══ DATE ══ -->
    <text x="540" y="720" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="26" font-weight="400" fill="#FFFFFF" opacity="0.9">
      ${dateStr} · ${timeNow} ET
    </text>

    <!-- ══ CTA PILL BUTTON ══ -->
    <!-- Pill background in vivid golden gradient -->
    <rect x="115" y="770" width="850" height="90" rx="45"
          fill="url(#ctaGrad)" filter="url(#softShadow)"/>
    <!-- CTA text: dark charcoal on gold — maximum legibility -->
    <text x="540" y="827" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="32" font-weight="800" letter-spacing="1"
          fill="#0D1B3E">
      Descubre el patrón de mañana → app.ballbot.tel
    </text>

    <!-- ══ FOOTER COPYRIGHT (brand-facing) ══ -->
    <text x="540" y="930" text-anchor="middle"
          font-family="'Segoe UI','Roboto',Arial,sans-serif"
          font-size="20" font-weight="600" letter-spacing="3"
          fill="#5A8AAA">
      © 2026 BallBot · app.ballbot.tel
    </text>

    <!-- ══ DIAGONAL WATERMARK (machine-readable layer, opacity minimal) ══ -->
    <g transform="translate(540, 540) rotate(-35)" opacity="0.02">
      <text x="0" y="-120" text-anchor="middle"
            font-family="'Segoe UI','Roboto',Arial,sans-serif"
            font-size="52" font-weight="900" letter-spacing="4"
            fill="#FFFFFF">
        BLISS SYSTEMS LLC
      </text>
      <text x="0" y="0" text-anchor="middle"
            font-family="'Segoe UI','Roboto',Arial,sans-serif"
            font-size="40" font-weight="700" letter-spacing="6"
            fill="#FFFFFF">
        app.ballbot.tel
      </text>
      <text x="0" y="120" text-anchor="middle"
            font-family="'Segoe UI','Roboto',Arial,sans-serif"
            font-size="52" font-weight="900" letter-spacing="4"
            fill="#FFFFFF">
        BLISS SYSTEMS LLC
      </text>
    </g>

  </g>
</svg>`.trim();

  // ── Level 3: EXIF/PNG metadata injection (legal authorship chain) ──
  const pngBuffer = await sharp(Buffer.from(svg))
    .png({ quality: 95 })
    .withMetadata({
      exif: {
        IFD0: {
          Copyright:    '© 2026 Bliss Systems LLC. All rights reserved.',
          Artist:       'Bliss Systems LLC',
          ImageDescription: 'BallBot HIT — Official Lottery Results · app.ballbot.tel',
          Software:     'BallBot Social Publisher v4.0 — Bliss Systems LLC',
        }
      }
    })
    .toBuffer();
  log(`🖼️  Imagen generada: ${SIZE}x${SIZE} PNG (${(pngBuffer.length / 1024).toFixed(0)} KB)`);
  return pngBuffer;
}

// ─── Save Image to Disk (for debugging / fallback) ───────────────────────────
async function saveImageToDisk(buffer, drawInfo) {
  const dir = path.join(__dirname, "../captures/social");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `hit_${drawInfo.type.replace(/\s+/g, "_")}_${timestamp}.png`;
  const filePath = path.join(dir, filename);

  fs.writeFileSync(filePath, buffer);
  log(`💾 Imagen guardada: ${filePath}`);

  // Cleanup: keep only last 20 social images
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".png"))
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  for (const old of files.slice(20)) {
    fs.unlinkSync(path.join(dir, old.name));
  }

  return filePath;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────
function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout (30s)"));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on("error", reject);
  });
}

// ─── Meta Graph API: Upload Image ────────────────────────────────────────────
/**
 * Uploads image to Meta via multipart/form-data.
 * Used for Facebook Page, Facebook Group, and as a pre-step for Instagram.
 */
async function uploadImageToMeta(imageBuffer, endpoint, message) {
  const boundary = `----BallbotBoundary${Date.now()}`;

  let body = "";
  // access_token field
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="access_token"\r\n\r\n`;
  body += `${META_CONFIG.pageAccessToken}\r\n`;
  // message field
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="message"\r\n\r\n`;
  body += `${message}\r\n`;
  // image file
  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="source"; filename="ballbot-hit.png"\r\n`;
  body += `Content-Type: image/png\r\n\r\n`;

  const bodyEnd = `\r\n--${boundary}--\r\n`;

  const bodyStart = Buffer.from(body, "utf-8");
  const bodyClose = Buffer.from(bodyEnd, "utf-8");
  const multipartBody = Buffer.concat([bodyStart, imageBuffer, bodyClose]);

  const urlObj = new URL(endpoint);
  const options = {
    hostname: urlObj.hostname,
    path: urlObj.pathname,
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": multipartBody.length,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Meta API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("Meta API upload timeout (60s)"));
    });
    req.write(multipartBody);
    req.end();
  });
}

// ─── Facebook Page Post ──────────────────────────────────────────────────────
async function postToFacebookPage(imageBuffer, message) {
  if (!META_CONFIG.pageId || !META_CONFIG.pageAccessToken) {
    log("⏭️  Facebook Page: no configurado (PAGE_ID o TOKEN faltante)");
    return null;
  }

  const endpoint = `https://graph.facebook.com/v21.0/${META_CONFIG.pageId}/photos`;
  try {
    const result = await uploadImageToMeta(imageBuffer, endpoint, message);
    log(`✅ Facebook Page publicado: post_id=${result.post_id || result.id}`);
    return result;
  } catch (e) {
    log(`❌ Facebook Page error: ${e.message}`);
    return null;
  }
}

// ─── Facebook Group Post ─────────────────────────────────────────────────────
async function postToFacebookGroup(imageBuffer, message) {
  if (!META_CONFIG.groupId || !META_CONFIG.pageAccessToken) {
    log("⏭️  Facebook Group: no configurado (GROUP_ID o TOKEN faltante)");
    return null;
  }

  const endpoint = `https://graph.facebook.com/v21.0/${META_CONFIG.groupId}/photos`;
  try {
    const result = await uploadImageToMeta(imageBuffer, endpoint, message);
    log(`✅ Facebook Group publicado: post_id=${result.post_id || result.id}`);
    return result;
  } catch (e) {
    log(`❌ Facebook Group error: ${e.message}`);
    return null;
  }
}

// ─── Instagram Post (2-step: create container → publish) ─────────────────────
async function postToInstagram(imageBuffer, message) {
  if (!META_CONFIG.igUserId || !META_CONFIG.pageAccessToken) {
    log("⏭️  Instagram: no configurado (IG_USER_ID o TOKEN faltante)");
    return null;
  }

  try {
    // Step 1: Save image to disk and serve temporarily, OR use an image URL.
    // Instagram API requires a publicly accessible URL for the image.
    // Strategy: Upload to Facebook first (unpublished), then use that URL.
    // Alternative: host temporarily. For now, we'll use a hosted image approach.

    // Upload to FB Page as unpublished photo to get a URL
    const boundary = `----BallbotBoundary${Date.now()}`;
    let body = "";
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="access_token"\r\n\r\n`;
    body += `${META_CONFIG.pageAccessToken}\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="published"\r\n\r\n`;
    body += `false\r\n`;
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="source"; filename="ballbot-hit.png"\r\n`;
    body += `Content-Type: image/png\r\n\r\n`;
    const bodyEnd = `\r\n--${boundary}--\r\n`;

    const bodyStart = Buffer.from(body, "utf-8");
    const bodyClose = Buffer.from(bodyEnd, "utf-8");
    const multipartBody = Buffer.concat([bodyStart, imageBuffer, bodyClose]);

    const uploadUrl = `https://graph.facebook.com/v21.0/${META_CONFIG.pageId}/photos`;
    const urlObj = new URL(uploadUrl);

    const uploadResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": multipartBody.length,
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`FB upload for IG ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
      req.write(multipartBody);
      req.end();
    });

    // Get the image URL from the unpublished photo
    const photoId = uploadResult.id;
    const photoData = await httpsGet(
      `https://graph.facebook.com/v21.0/${photoId}?fields=images&access_token=${META_CONFIG.pageAccessToken}`
    );
    const imageUrl = photoData.images?.[0]?.source;

    if (!imageUrl) {
      throw new Error("Could not get image URL from unpublished FB photo");
    }

    // Step 2: Create Instagram media container
    const containerParams = new URLSearchParams({
      image_url: imageUrl,
      caption: message,
      access_token: META_CONFIG.pageAccessToken,
    });

    const container = await httpsRequest({
      hostname: "graph.facebook.com",
      path: `/v21.0/${META_CONFIG.igUserId}/media`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, containerParams.toString());

    const creationId = container.body.id;
    log(`📦 Instagram container creado: ${creationId}`);

    // Step 3: Wait a moment for processing, then publish
    await new Promise((r) => setTimeout(r, 3000));

    const publishParams = new URLSearchParams({
      creation_id: creationId,
      access_token: META_CONFIG.pageAccessToken,
    });

    const published = await httpsRequest({
      hostname: "graph.facebook.com",
      path: `/v21.0/${META_CONFIG.igUserId}/media_publish`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }, publishParams.toString());

    log(`✅ Instagram publicado: media_id=${published.body.id}`);
    return published.body;
  } catch (e) {
    log(`❌ Instagram error: ${e.message}`);
    return null;
  }
}

// ─── Telegram Channel Post ──────────────────────────────────────────────────
/**
 * Sends the branded PNG + caption to the Telegram channel via Bot API sendPhoto.
 * The bot must be an admin of the channel with "Post Messages" permission.
 *
 * @param {Buffer} imageBuffer - PNG image buffer
 * @param {string} message - Caption text (Telegram supports up to 1024 chars for photos)
 * @returns {Promise<object|null>} Telegram API response or null on failure
 */
async function postToTelegram(imageBuffer, message) {
  if (!TELEGRAM_CONFIG.botToken) {
    log("⏭️  Telegram: no configurado (TELEGRAM_BOT_TOKEN faltante)");
    return null;
  }

  const channelId = TELEGRAM_CONFIG.channelId;
  if (!channelId) {
    log("⏭️  Telegram: no configurado (TELEGRAM_CHANNEL_ID faltante)");
    return null;
  }

  try {
    const boundary = `----TelegramBoundary${Date.now()}`;

    // Build multipart body: chat_id + caption + parse_mode + photo
    let bodyParts = "";
    // chat_id
    bodyParts += `--${boundary}\r\n`;
    bodyParts += `Content-Disposition: form-data; name="chat_id"\r\n\r\n`;
    bodyParts += `${channelId}\r\n`;
    // caption
    bodyParts += `--${boundary}\r\n`;
    bodyParts += `Content-Disposition: form-data; name="caption"\r\n\r\n`;
    bodyParts += `${message}\r\n`;
    // parse_mode (HTML for bold/links)
    bodyParts += `--${boundary}\r\n`;
    bodyParts += `Content-Disposition: form-data; name="parse_mode"\r\n\r\n`;
    bodyParts += `HTML\r\n`;
    // photo file
    bodyParts += `--${boundary}\r\n`;
    bodyParts += `Content-Disposition: form-data; name="photo"; filename="ballbot-hit.png"\r\n`;
    bodyParts += `Content-Type: image/png\r\n\r\n`;

    const bodyEnd = `\r\n--${boundary}--\r\n`;
    const bodyStart = Buffer.from(bodyParts, "utf-8");
    const bodyClose = Buffer.from(bodyEnd, "utf-8");
    const multipartBody = Buffer.concat([bodyStart, imageBuffer, bodyClose]);

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "api.telegram.org",
        path: `/bot${TELEGRAM_CONFIG.botToken}/sendPhoto`,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": multipartBody.length,
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) {
            resolve(parsed);
          } else {
            reject(new Error(`Telegram API ${res.statusCode}: ${parsed.description || data}`));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("Telegram API timeout (30s)")); });
      req.write(multipartBody);
      req.end();
    });

    const msgId = result.result?.message_id;
    log(`✅ Telegram publicado: channel=${channelId} message_id=${msgId}`);
    return result;
  } catch (e) {
    log(`❌ Telegram error: ${e.message}`);
    return null;
  }
}

// ─── Build Social Media Caption ──────────────────────────────────────────────
function buildCaption(drawInfo, extractedNumbers) {
  const p3 = extractedNumbers?.p3 || "???";
  const p4 = extractedNumbers?.p4 || "????";
  const periodLabel = drawInfo.emoji === "☀️" ? "Mediodía" : "Noche";

  return [
    `${drawInfo.emoji} RESULTADOS OFICIALES — Pick ${periodLabel}`,
    ``,
    `🎯 Pick 3: ${p3}`,
    `🎯 Pick 4: ${p4}`,
    ``,
    `✅ Verificado automáticamente por Ballbot`,
    ``,
    `📲 Estrategias y predicciones en tiempo real:`,
    META_CONFIG.ctaUrl,
    ``,
    `#FloridaLottery #Pick3 #Pick4 #Ballbot #Loteria`,
  ].join("\n");
}

/**
 * Builds an HTML-formatted caption for Telegram.
 * Telegram photo captions support HTML: <b>, <i>, <a>, <code>.
 */
function buildTelegramCaption(drawInfo, extractedNumbers) {
  const p3 = extractedNumbers?.p3 || "???";
  const p4 = extractedNumbers?.p4 || "????";
  const periodLabel = drawInfo.emoji === "☀️" ? "Mediodía" : "Noche";

  return [
    `${drawInfo.emoji} <b>RESULTADOS OFICIALES</b> — Pick ${periodLabel}`,
    ``,
    `🎯 Pick 3: <b>${p3}</b>`,
    `🎯 Pick 4: <b>${p4}</b>`,
    ``,
    `✅ Verificado por <b>Ballbot</b>`,
    ``,
    `📲 <a href="${META_CONFIG.ctaUrl}">Estrategias en tiempo real</a>`,
  ].join("\n");
}

// ─── Main Entry Point ────────────────────────────────────────────────────────
/**
 * Publishes lottery results to all configured social media channels.
 * Called from monitor.js at the same level as sendEmail() and webhook.
 *
 * @param {object} params
 * @param {object} params.drawInfo - { type, period, emoji } from classifyVideo()
 * @param {object} params.extractedNumbers - { p3, p4, confidence, source }
 * @param {string} [params.videoTitle] - Original YouTube video title (for date extraction)
 * @returns {Promise<object>} Results from each platform { facebook, instagram, group }
 */
async function publishToSocial({ drawInfo, extractedNumbers, videoTitle }) {
  const hasMetaConfig = META_CONFIG.pageAccessToken && (META_CONFIG.pageId || META_CONFIG.igUserId || META_CONFIG.groupId);
  const hasTelegramConfig = !!TELEGRAM_CONFIG.botToken;

  if (!hasMetaConfig && !hasTelegramConfig) {
    log("⏭️  Social publisher: ninguna plataforma configurada — saltando");
    return { facebook: null, instagram: null, group: null, telegram: null };
  }

  const p3 = extractedNumbers?.p3 || null;
  const p4 = extractedNumbers?.p4 || null;

  if (!p3 && !p4) {
    log("⏭️  Social publisher: sin números extraídos — saltando");
    return { facebook: null, instagram: null, group: null, telegram: null };
  }

  log(`📣 Social publisher: iniciando publicación para ${drawInfo.type}...`);

  // ── Step 1: Generate branded image ──
  let imageBuffer;
  try {
    imageBuffer = await generateHitImage({
      p3,
      p4,
      type: drawInfo.type,
      emoji: drawInfo.emoji,
      date: null, // auto-generates from current date
    });
  } catch (e) {
    log(`❌ Image generation failed: ${e.message}`);
    return { facebook: null, instagram: null, group: null, telegram: null };
  }

  // Save image to disk (audit trail + debugging)
  try {
    await saveImageToDisk(imageBuffer, drawInfo);
  } catch (_) { }

  // ── Step 2: Build captions (different formats per platform) ──
  const metaCaption = buildCaption(drawInfo, extractedNumbers);
  const telegramCaption = buildTelegramCaption(drawInfo, extractedNumbers);

  // ── Step 3: Publish to all platforms in parallel ──
  const [facebook, instagram, group, telegram] = await Promise.allSettled([
    postToFacebookPage(imageBuffer, metaCaption),
    postToInstagram(imageBuffer, metaCaption),
    postToFacebookGroup(imageBuffer, metaCaption),
    postToTelegram(imageBuffer, telegramCaption),
  ]);

  const results = {
    facebook: facebook.status === "fulfilled" ? facebook.value : null,
    instagram: instagram.status === "fulfilled" ? instagram.value : null,
    group: group.status === "fulfilled" ? group.value : null,
    telegram: telegram.status === "fulfilled" ? telegram.value : null,
  };

  const total = Object.keys(results).length;
  const published = Object.values(results).filter(Boolean).length;
  log(`📣 Social publisher: ${published}/${total} plataformas publicadas exitosamente`);

  return results;
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = {
  publishToSocial,
  generateHitImage,
  saveImageToDisk,
  postToTelegram,
};
