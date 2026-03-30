/**
 * TEST SNIPER DEV-ONLY — MODO SILENCIOSO
 * Ejecuta el flujo real completo pero bloquea categóricamente cualquier envío a Producción.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const https = require("https");
const http = require("http");
const url = require("url");
const { analyzeVideo } = require("./video-analyzer");

// 🛡️ GUARDRAIL: Forzar WEBHOOK_URL a SOLO DEV
const rawWebhooks = (process.env.WEBHOOK_URL || "").split(",");
const DEV_URL = rawWebhooks.find(u => u.includes("dev.onrender.com")) || "https://power-ball-dev.onrender.com/hit";

const CONFIG = {
  webhook_url: DEV_URL,
  webhook_secret: process.env.WEBHOOK_SECRET || "",
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] [DEV-SNIPER] ${msg}`);
}

function httpPost(targetUrl, jsonBody) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const bodyBuf = Buffer.from(jsonBody, "utf8");
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (targetUrl.startsWith("https") ? 443 : 80),
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
      },
      timeout: 15000,
    };
    const lib = targetUrl.startsWith("https") ? https : http;
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

function formatDrawDate(title) {
  const match = title.match(/(\d{4})(\d{2})(\d{2})/);
  if (match) return `${match[2]}/${match[3]}/${match[1].slice(-2)}`;
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", year: "2-digit" });
}

async function main() {
  log("🛡️ STARTING SILENT DEV TEST (PRODUCTION IS BLOCKED)...");
  log(`🎯 Target Webhook: ${CONFIG.webhook_url}`);
  
  if (CONFIG.webhook_url.includes("zshy") || !CONFIG.webhook_url.includes("dev")) {
    log("🛑 CRITICAL ERROR: Target URL must be DEV. Aborting.");
    process.exit(1);
  }

  // 1. Get latest video from RSS
  const rssXml = await new Promise((resolve, reject) => {
    https.get("https://www.youtube.com/feeds/videos.xml?channel_id=UCPm7mcdzUK9PjQtdGX4_Niw", res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
    }).on("error", reject);
  });

  const entryMatch = rssXml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) throw new Error("No videos found");
  
  const videoId = (entryMatch[1].match(/yt:videoId>(.*?)<\/yt:videoId/) || [])[1];
  const videoTitle = (entryMatch[1].match(/<title>(.*?)<\/title>/) || [])[1] || "";
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  log(`🎬 Detected Latest: "${videoTitle}" (${videoId})`);

  // 2. Full AI Analysis
  log(`🧠 Analyzing video via AI Pipeline...`);
  const result = await analyzeVideo(videoUrl, videoId, videoTitle);
  log(`✅ AI Result: P3=${result.p3 || "?"} P4=${result.p4 || "?"} [${result.confidence}]`);

  // 3. Webhook Dispatch strictly to DEV
  if (result.p3 || result.p4) {
    const drawDate = formatDrawDate(videoTitle);
    const period = videoTitle.toLowerCase().includes("midday") ? "m" : "e";

    log(`🚀 Dispatching strictly to ${CONFIG.webhook_url}...`);
    if (result.p3) {
      await httpPost(CONFIG.webhook_url, JSON.stringify({
        date: drawDate, game: "p3", period, numbers: result.p3.split("").join(","), secret: CONFIG.webhook_secret
      }));
    }
    if (result.p4) {
      await httpPost(CONFIG.webhook_url, JSON.stringify({
        date: drawDate, game: "p4", period, numbers: result.p4.split("").join(","), secret: CONFIG.webhook_secret
      }));
    }
    log(`   ✅ Sent ${drawDate} ${period} successfully to DEV.`);
  }

  log("🏆 Silent Dev Test Complete. Production was unharmed.");
}

main().catch(e => { console.error("❌ Test Failed:", e); process.exit(1); });
