/**
 * Florida Lottery YouTube Monitor
 * Watches the official FL Lottery channel for new draw result videos,
 * extracts frame screenshots, emails results AND notifies ballbot webhook.
 *
 * Channel: https://www.youtube.com/channel/UCPm7mcdzUK9PjQtdGX4_Niw
 *
 * BUG FIX 2026-03-24: FL Lottery changed title format from
 *   "Florida Lottery — Pick 3 Midday Results" (OLD, never matched)
 *   to "Pick Midday 20260323" / "Pick Evening 20260323" (CURRENT)
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const url = require("url");
const { analyzeVideo, cleanupAnalysis } = require("./video-analyzer");

// ─── Environment & Config ──────────────────────────────────────────────────
require("dotenv").config();
const CONFIG = require("../config/config.json");

// Environment Overrides (Security First)
if (process.env.GEMINI_API_KEY) CONFIG.gemini_api_key = process.env.GEMINI_API_KEY;
if (process.env.DATABASE_URL) CONFIG.database_url = process.env.DATABASE_URL;
if (process.env.WEBHOOK_URL) CONFIG.webhook_url = process.env.WEBHOOK_URL;
if (process.env.WEBHOOK_SECRET) CONFIG.webhook_secret = process.env.WEBHOOK_SECRET;

// SMTP Overrides
if (process.env.SMTP_HOST) CONFIG.smtp.host = process.env.SMTP_HOST;
if (process.env.SMTP_PORT) CONFIG.smtp.port = parseInt(process.env.SMTP_PORT);
if (process.env.SMTP_USER) CONFIG.smtp.user = process.env.SMTP_USER;
if (process.env.SMTP_PASS) CONFIG.smtp.pass = process.env.SMTP_PASS;
if (process.env.SMTP_SECURE) CONFIG.smtp.secure = process.env.SMTP_SECURE === "true";

// Other Overrides
if (process.env.STATUS_PORT) CONFIG.status_port = parseInt(process.env.STATUS_PORT);
if (process.env.RECIPIENTS) CONFIG.recipients = process.env.RECIPIENTS.split(",").map(e => e.trim());

const STATE_FILE = path.join(__dirname, "../config/state.json");

// ─── State Management ───────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { processedVideos: [] };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { processedVideos: [] };
  }
}

function saveState(state) {
  // Atomic write via temp file to avoid corruption on power failure
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ─── YouTube Source Polling (Direct Scrape & RSS Fallback) ──────────────────
const CHANNEL_ID = "UCPm7mcdzUK9PjQtdGX4_Niw";
const CHANNEL_VIDEOS_URL = `https://www.youtube.com/@FloridaLottery/videos`;
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

/**
 * Fetches latest videos by scraping the channel's /videos page.
 * This is MUCH faster than RSS (near real-time).
 */
function fetchLatestVideosViaScrape() {
  return new Promise((resolve, reject) => {
    https.get(CHANNEL_VIDEOS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    }, (res) => {
      let html = "";
      res.on("data", (chunk) => (html += chunk));
      res.on("end", () => {
        try {
          const match = html.match(/var ytInitialData = ({.*?});<\/script>/);
          if (!match) return resolve([]);

          const data = JSON.parse(match[1]);
          const videos = [];
          
          // YouTube renders content in deep nested structures
          const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs;
          if (!tabs) return resolve([]);

          const videosTab = tabs.find(t => t.tabRenderer?.title === 'Videos' || t.tabRenderer?.endpoint?.browseEndpoint?.params?.includes('Egl2aWRlb3'));
          const contents = videosTab?.tabRenderer?.content?.richGridRenderer?.contents || [];

          for (const item of contents) {
            const v = item.richItemRenderer?.content?.videoRenderer;
            if (v && v.videoId) {
              videos.push({
                id: v.videoId,
                title: v.title.runs[0].text,
                url: `https://www.youtube.com/watch?v=${v.videoId}`,
                published: v.publishedTimeText?.simpleText || 'Recently'
              });
            }
          }
          resolve(videos);
        } catch (err) {
          log(`⚠️ Scraping parse error: ${err.message}`);
          resolve([]); // Fallback to RSS if scrape fails
        }
      });
    }).on("error", (err) => {
      log(`⚠️ Scraping fetch error: ${err.message}`);
      resolve([]);
    });
  });
}

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function parseRSSVideos(xml) {
  const videos = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const id = (entry.match(/yt:videoId>(.*?)<\/yt:videoId/) || [])[1];
    const title = (entry.match(/<title>(.*?)<\/title>/) || [])[1] || "";
    const published = (entry.match(/<published>(.*?)<\/published>/) || [])[1] || "";
    const updated = (entry.match(/<updated>(.*?)<\/updated>/) || [])[1] || "";

    if (id) {
      videos.push({
        id,
        title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
        url: `https://www.youtube.com/watch?v=${id}`,
        published,
        updated,
      });
    }
  }

  return videos;
}

// ─── Draw Classification ────────────────────────────────────────────────────
// FL Lottery current title format (as of 2026): "Pick Midday 20260323", "Pick Evening 20260323"
// Legacy format (2024 and before): "Florida Lottery — Pick 3 Midday Results — 03/24/2026"
const DRAW_PATTERNS = [
  // ── CURRENT FORMAT (2025+): one video covers Pick 3 + Pick 4 together ──
  { regex: /^pick\s+mid/i, type: "Pick Midday", period: "m", emoji: "☀️" },
  { regex: /^pick\s+eve/i, type: "Pick Evening", period: "e", emoji: "🌙" },
  // ── LEGACY FORMAT (fallback — kept for historical / format changes) ──
  { regex: /pick\s*3.*mid/i, type: "Pick 3 Midday", period: "m", emoji: "☀️" },
  { regex: /pick\s*3.*eve/i, type: "Pick 3 Evening", period: "e", emoji: "🌙" },
  { regex: /pick\s*4.*mid/i, type: "Pick 4 Midday", period: "m", emoji: "☀️" },
  { regex: /pick\s*4.*eve/i, type: "Pick 4 Evening", period: "e", emoji: "🌙" },
  { regex: /pick\s*3/i, type: "Pick 3", period: null, emoji: "🎱" },
  { regex: /pick\s*4/i, type: "Pick 4", period: null, emoji: "🎱" },
];

const MONITORED_TYPES = CONFIG.monitored_draws || [
  "Pick Midday",
  "Pick Evening",
  "Pick 3 Midday",
  "Pick 3 Evening",
  "Pick 4 Midday",
  "Pick 4 Evening",
];

function classifyVideo(title) {
  for (const pattern of DRAW_PATTERNS) {
    if (pattern.regex.test(title)) {
      return pattern;
    }
  }
  return null;
}

function isMonitored(drawType) {
  return MONITORED_TYPES.some((t) => drawType.startsWith(t) || drawType === t);
}

// ─── Ballbot Webhook Notification ──────────────────────────────────────────
function httpPost(targetUrl, jsonBody) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const bodyBuf = Buffer.from(jsonBody, "utf8");

    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
      },
      timeout: 15000,
    };

    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Analyzes the video with AI and notifies Ballbot with extracted numbers.
 * 
 * Pipeline:
 *   1. Download video & extract frames + audio (VideoAnalyzer)
 *   2. Gemini Vision + Audio → cross-validated numbers
 *   3. Send numbers directly to Ballbot webhook
 * 
 * ZERO PDF dependency. Numbers come from the video itself.
 */
/**
 * Formats YYYYMMDD from title to MM/DD/YY for Postgres "date" column.
 */
function formatDrawDate(title) {
  const match = title.match(/(\d{4})(\d{2})(\d{2})/);
  if (match) {
    const [_, yyyy, mm, dd] = match;
    return `${mm}/${dd}/${yyyy.slice(-2)}`;
  }
  // Fallback to current date ET
  const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const mm = String(et.getMonth() + 1).padStart(2, "0");
  const dd = String(et.getDate()).padStart(2, "0");
  const yy = String(et.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/**
 * Formats "774" to "7,7,4" for Postgres "numbers" column.
 */
function formatNumbers(str) {
  if (!str) return "";
  return str.split("").join(",");
}

/**
 * Analyzes the video with AI and notifies Ballbot with extracted numbers.
 * Sends two separate requests (P3 and P4) to match the Postgres row structure.
 */
async function notifyBallbot(draw, video) {
  if (!CONFIG.webhook_url) {
    log("⚠️  webhook_url no configurado — saltando integración ballbot");
    return;
  }

  const drawDate = formatDrawDate(video.title);

  // ── Step 1: AI Video Analysis ─────────────────────────────────────────
  let extractedNumbers = null;
  try {
    log(`🧠 Initiating AI video analysis for ${video.id}...`);
    extractedNumbers = await analyzeVideo(video.url, video.id, video.title);
    log(`🎯 AI extraction complete: P3=${extractedNumbers.p3 || "N/A"} P4=${extractedNumbers.p4 || "N/A"} [${extractedNumbers.confidence.toUpperCase()}]`);
  } catch (e) {
    log(`❌ Video analysis failed: ${e.message}`);
    log(`⚠️  Cannot proceed with identical Postgres mapping without numbers.`);
    return;
  }

  // ── Step 2: Prepare specific payloads for P3 and P4 ──────────────────
  const gamesToNotify = [];
  if (extractedNumbers.p3) {
    gamesToNotify.push({
      date: drawDate,
      game: "p3",
      period: draw.period,
      numbers: formatNumbers(extractedNumbers.p3),
      secret: CONFIG.webhook_secret || "",
    });
  }
  if (extractedNumbers.p4) {
    gamesToNotify.push({
      date: drawDate,
      game: "p4",
      period: draw.period,
      numbers: formatNumbers(extractedNumbers.p4),
      secret: CONFIG.webhook_secret || "",
    });
  }

  // ── Step 3: Send separate calls (Relentless Retry) ───────────────────
  for (const payloadItem of gamesToNotify) {
    const payload = JSON.stringify(payloadItem);
    const maxRetries = 3;
    const retryDelay = 10000;

    let success = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log(`📡 Sending [${payloadItem.game.toUpperCase()}] to Ballbot...`);
        const raw = await httpPost(CONFIG.webhook_url, payload);
        const response = JSON.parse(raw);
        log(`✅ Ballbot notificado [${payloadItem.game.toUpperCase()}]: ${response.message || "OK"}`);
        success = true;
        break;
      } catch (e) {
        log(`❌ Webhook error [${payloadItem.game.toUpperCase()}] (intento ${attempt}/${maxRetries}): ${e.message}`);
        if (attempt < maxRetries) await sleep(retryDelay);
      }
    }
  }

  // Cleanup is now managed by VideoAnalyzer's periodic rotation (last 14)
  // to avoid deleting the goldFrame before the email is sent.
  
  return extractedNumbers; 
}

// ─── Frame Capture with yt-dlp + ffmpeg ────────────────────────────────────
const CAPTURE_DIR = path.join(__dirname, "../captures");
if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });

function captureFrame(videoUrl, videoId) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(CAPTURE_DIR, `${videoId}_frame.jpg`);
    const thumbnailPath = path.join(CAPTURE_DIR, `${videoId}_thumb.jpg`);

    // Strategy 1: Use yt-dlp to get the best thumbnail (fast, always available)
    const thumbCmd = `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "${path.join(CAPTURE_DIR, videoId)}" "${videoUrl}" 2>&1`;

    log(`📸 Capturing frame for ${videoId}...`);

    exec(thumbCmd, { timeout: 60000 }, (_err, _stdout) => {
      // Check if thumbnail was saved with various possible extensions
      const possibleFiles = [`${videoId}.jpg`, `${videoId}.webp`, `${videoId}.png`].map((f) =>
        path.join(CAPTURE_DIR, f)
      );

      const existingThumb = possibleFiles.find((f) => fs.existsSync(f));

      if (existingThumb) {
        if (existingThumb !== thumbnailPath) {
          fs.renameSync(existingThumb, thumbnailPath);
        }
        log(`✅ Thumbnail captured: ${thumbnailPath}`);
        return resolve(thumbnailPath);
      }

      // Strategy 2: Try to grab a mid-video frame with ffmpeg
      log(`⚠️  Thumbnail not found, trying ffmpeg frame extraction...`);
      const ffmpegCmd = `yt-dlp -g "${videoUrl}" 2>/dev/null | head -1`;

      exec(ffmpegCmd, { timeout: 30000 }, (err2, streamUrl) => {
        if (err2 || !streamUrl.trim()) {
          return reject(new Error("Could not get stream URL"));
        }

        const ffmpeg = `ffmpeg -i "${streamUrl.trim()}" -ss 00:00:03 -vframes 1 -q:v 2 "${outputPath}" -y 2>&1`;
        exec(ffmpeg, { timeout: 60000 }, (err3) => {
          if (err3 || !fs.existsSync(outputPath)) {
            return reject(new Error("Frame extraction failed"));
          }
          log(`✅ Frame captured via ffmpeg: ${outputPath}`);
          resolve(outputPath);
        });
      });
    });
  });
}

// ─── Captures Cleanup (7-day rotation) ─────────────────────────────────────
function cleanOldCaptures() {
  try {
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const files = fs.readdirSync(CAPTURE_DIR);
    let removed = 0;
    for (const file of files) {
      const fp = path.join(CAPTURE_DIR, file);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    if (removed > 0) log(`🧹 Cleanup: ${removed} capturas antiguas eliminadas`);
  } catch (e) {
    log(`⚠️  Cleanup error: ${e.message}`);
  }
}

// ─── Email via Nodemailer ───────────────────────────────────────────────────
async function sendEmail(drawInfo, imagePath, videoUrl, videoTitle, extractedNumbers) {
  const nodemailer = require("nodemailer");

  const transporter = nodemailer.createTransport({
    host: CONFIG.smtp.host,
    port: CONFIG.smtp.port,
    secure: CONFIG.smtp.secure,
    auth: {
      user: CONFIG.smtp.user,
      pass: CONFIG.smtp.pass,
    },
  });

  const now = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });

  // Enriched Subject: [HIT] Emoji Type: P3 / P4
  const p3Str = extractedNumbers?.p3 || "??";
  const p4Str = extractedNumbers?.p4 || "????";
  const subject = `[HIT] ${drawInfo.emoji} ${drawInfo.type}: ${p3Str} / ${p4Str} — ${now}`;

  const html = `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #050505; color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #222;">
      <div style="background: linear-gradient(135deg, #0f172a, #1e293b); padding: 30px; text-align: center; border-bottom: 2px solid #ffd700;">
        <h1 style="margin: 0; font-size: 32px; color: #ffd700; letter-spacing: 2px;">${drawInfo.emoji} BALLBOT HIT</h1>
        <p style="margin: 10px 0 0; color: #94a3b8; font-size: 16px; font-weight: 600; text-transform: uppercase;">${drawInfo.type} OFICIAL</p>
      </div>
      
      <div style="padding: 30px; text-align: center;">
        <div style="display: flex; justify-content: center; gap: 20px; margin-bottom: 30px;">
          <div style="background: #111; padding: 20px; border-radius: 12px; border: 1px solid #333; min-width: 120px;">
            <div style="color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Pick 3</div>
            <div style="color: #ffd700; font-size: 36px; font-weight: bold;">${p3Str}</div>
          </div>
          <div style="background: #111; padding: 20px; border-radius: 12px; border: 1px solid #333; min-width: 120px;">
            <div style="color: #64748b; font-size: 12px; text-transform: uppercase; margin-bottom: 5px;">Pick 4</div>
            <div style="color: #ffd700; font-size: 36px; font-weight: bold;">${p4Str}</div>
          </div>
        </div>

        <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">
          📺 Fuente: <a href="${videoUrl}" style="color: #38bdf8; text-decoration: none;">${videoTitle}</a>
        </p>
        
        ${imagePath ? `<div style="margin-top: 10px;"><img src="cid:capture" style="width: 100%; border-radius: 12px; border: 1px solid #444;" /></div>` : ""}
        
        <div style="margin-top: 30px; padding: 15px; background: #0f172a; border-radius: 8px; border-left: 4px solid #38bdf8;">
          <p style="margin: 0; color: #64748b; font-size: 12px; line-height: 1.6;">
            <strong>AUDITORÍA VERIFICADA:</strong> Este resultado ha sido verificado y sincronizado automáticamente por Ballbot.
          </p>
        </div>
      </div>
      <div style="background: #000; padding: 15px; text-align: center; font-size: 11px; color: #444;">
        &copy; 2026 BallBot — hit.ballbot.tel
      </div>
    </div>
  `;

  const mailOptions = {
    from: `"Ballbot HIT" <${CONFIG.smtp.user}>`,
    to: CONFIG.recipients.join(", "),
    subject,
    html,
    attachments: imagePath
      ? [
        {
          filename: path.basename(imagePath),
          path: imagePath,
          cid: "capture",
        },
      ]
      : [],
  };

  await transporter.sendMail(mailOptions);
  log(`📧 Email enviado con resultados: ${subject}`);
}

// ─── Logger ─────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  const logFile = path.join(__dirname, "../logs/monitor.log");
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(logFile, line + "\n");
}

// ─── Main Poll Loop ─────────────────────────────────────────────────────────
async function pollChannel() {
  log("🔍 Polling Florida Lottery YouTube channel...");

  try {
    // 1. Try Direct Scrape First (Real-time)
    let videos = await fetchLatestVideosViaScrape();
    
    // 2. If scrape failed or found nothing, fallback to RSS
    if (videos.length === 0) {
      log("ℹ️ Scrape found no videos, falling back to RSS...");
      const xml = await fetchRSS(RSS_URL);
      videos = parseRSSVideos(xml);
    }

    if (videos.length === 0) {
      log("⚠️ No videos found in any source.");
      return;
    }

    log(`📋 Found ${videos.length} videos in feed`);
    const state = loadState();
    let foundAnyNew = false;

    for (const video of videos) {
      if (state.processedVideos.includes(video.id)) continue;

      const draw = classifyVideo(video.title);
      if (!draw) {
        log(`⏭️  Skipping: "${video.title}" (not a draw video)`);
        state.processedVideos.push(video.id);
        continue;
      }

      if (!isMonitored(draw.type)) {
        log(`⏭️  Skipping: "${video.title}" (${draw.type} not in monitored list)`);
        state.processedVideos.push(video.id);
        continue;
      }

      log(`🎯 NEW DRAW VIDEO: "${video.title}" → ${draw.type} [period=${draw.period}]`);

      let extractionSuccess = false;

      // ── Analyze video with AI + Notify Ballbot with extracted numbers ────
      if (draw.period) {
        let extractedNumbers = null;
        try {
          extractedNumbers = await notifyBallbot(draw, video);
          if (extractedNumbers && extractedNumbers.p3 && extractedNumbers.p4) {
            extractionSuccess = true;
          }
        } catch (e) {
          log(`❌ notifyBallbot error: ${e.message}`);
        }

        // ── Step 2: Capture frame for email ──
        let imagePath = extractedNumbers?.goldFrame || null;
        if (!imagePath) {
          try {
            imagePath = await captureFrame(video.url, video.id);
          } catch (e) {
            log(`⚠️  Frame capture failed: ${e.message}`);
          }
        }

        // ── Step 3: Send email notification ──
        try {
          if (CONFIG.smtp && CONFIG.smtp.user && CONFIG.smtp.user !== "TU_EMAIL@gmail.com") {
            await sendEmail(draw, imagePath, video.url, video.title, extractedNumbers);
          }
        } catch (e) {
          log(`❌ Email failed: ${e.message}`);
        }
      } else {
        log(`⚠️  No period mapped for "${draw.type}" — notifications skipped`);
        extractionSuccess = true; 
      }

      if (extractionSuccess) {
        lastSuccessfulSnipeTime = Date.now(); // 💥 SNIPER KILL-SWITCH ACTIVADO
        log(`🛑 Kill-Switch activado: Misión completada, abortando sondeo agresivo.`);
        state.processedVideos.push(video.id);
        
        if (state.processedVideos.length > 200) {
          state.processedVideos = state.processedVideos.slice(-200);
        }
        saveState(state);
      } else {
        log(`⚠️ Misión incompleta para "${video.title}". Se reintentará en el próximo ciclo.`);
      }
    }
  } catch (e) {
    log(`❌ Poll error: ${e.message}`);
  }
}

// ─── HTTP Status Server ─────────────────────────────────────────────────────
function startStatusServer() {
  const port = CONFIG.status_port || 3456;

  http
    .createServer((_req, res) => {
      const state = loadState();
      const logFile = path.join(__dirname, "../logs/monitor.log");
      const recentLogs = fs.existsSync(logFile)
        ? fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-50)
          .reverse()
          .join("\n")
        : "No logs yet";

      const payload = {
        status: "running",
        monitored_draws: MONITORED_TYPES,
        processed_count: state.processedVideos.length,
        last_processed: state.processedVideos.slice(-5).reverse(),
        channel: `https://www.youtube.com/channel/${CHANNEL_ID}`,
        recent_logs: recentLogs,
        uptime_seconds: Math.floor(process.uptime()),
        webhook_configured: !!CONFIG.webhook_url,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    })
    .listen(port, () => {
      log(`🌐 Status server running on http://localhost:${port}`);
    });
}

// ─── Smart Window Polling ───────────────────────────────────────────────────
// Normal mode: every CONFIG.poll_interval_ms (default 120s)
// Draw window: every 15s when close to expected YouTube upload time
//   Midday window:  13:33–13:55 ET  (draw 13:30, video usually posted 13:35–13:45)
//   Evening window: 21:48–22:05 ET  (draw 21:45, video usually posted 21:50–22:00)

const WINDOW_INTERVAL_MS = 15_000; // 15 seconds for Instant-Hit detection
const SNIPE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours cooldown after a successful hit
let lastSuccessfulSnipeTime = 0; // State variable for the Sniper Kill-Switch

function isInDrawWindow() {
  const etStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const totalMin = et.getHours() * 60 + et.getMinutes();
  
  // Midday Window: Starts 13:33 (when videos drop) until 13:55
  const middayWindow = totalMin >= 13 * 60 + 33 && totalMin <= 13 * 60 + 55;
  
  // Evening Window: Starts 21:48 (when videos drop) until 22:05
  const eveningWindow = totalMin >= 21 * 60 + 48 && totalMin <= 22 * 60 + 5;
  
  const inTimeWindow = middayWindow || eveningWindow;

  if (inTimeWindow && (Date.now() - lastSuccessfulSnipeTime < SNIPE_COOLDOWN_MS)) {
    // We are in the window, but we already successfully sniped the draw.
    // Return false to turn off the aggressive polling.
    return false; 
  }

  return inTimeWindow;
}

/** Dynamic scheduler: switches between 30s (draw window) and normal interval. */
function schedulePoll() {
  const inWindow = isInDrawWindow();
  const delay = inWindow ? WINDOW_INTERVAL_MS : CONFIG.poll_interval_ms;
  if (inWindow) log(`⚡ DRAW WINDOW active — next poll in ${delay / 1000}s`);
  setTimeout(async () => {
    await pollChannel();
    schedulePoll(); // recursive — adapts delay on each iteration
  }, delay);
}

// ─── Entry Point ────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    log("🚀 Florida Lottery Monitor starting...");
    log(`📺 Channel: https://www.youtube.com/channel/${CHANNEL_ID}`);
    log(`🎯 Monitoring: ${MONITORED_TYPES.join(", ")}`);
    log(`📧 Recipients: ${(CONFIG.recipients || []).join(", ")}`);
    log(`⏱️  Normal interval: ${CONFIG.poll_interval_ms / 1000}s | Window interval: ${WINDOW_INTERVAL_MS / 1000}s`);
    log(`🔗 Ballbot webhook: ${CONFIG.webhook_url || "NOT CONFIGURED"}`);

    startStatusServer();

    // Cleanup old captures once at start
    cleanOldCaptures();

    // Run immediately on start, then use smart scheduler
    await pollChannel();
    schedulePoll();

    // Daily cleanup at midnight
    setInterval(cleanOldCaptures, 24 * 60 * 60 * 1000);
  })();
}
module.exports = { fetchLatestVideosViaScrape };
