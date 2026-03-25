/**
 * TEST CAPTURE — Lottery Monitor Full Step-by-Step
 * This test will:
 * 1. Fetch RSS and identify the LATEST video matching "Pick Midday" or "Pick Evening".
 * 2. Attempt a full frame capture using yt-dlp + ffmpeg.
 * 3. Log results and provide the path to the screenshot.
 *
 * Usage: node src/test-capture.js
 */

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const url = require("url");

// ─── Config ────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "../config/config.json");
let CONFIG = { monitored_draws: ["Pick Midday", "Pick Evening"] };
if (fs.existsSync(CONFIG_PATH)) {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

const CAPTURE_DIR = path.join(__dirname, "../captures");
if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });

const CHANNEL_ID = "UCPm7mcdzUK9PjQtdGX4_Niw";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

// ─── Core Functions from monitor.js ──────────────────────────────────────────

function fetchRSS(feedUrl) {
  return new Promise((resolve, reject) => {
    console.log(`📡 [STEP 1] Fetching RSS feed: ${feedUrl}`);
    https
      .get(feedUrl, (res) => {
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
    const title = ((entry.match(/<title>(.*?)<\/title>/) || [])[1] || "").replace(/&amp;/g, "&");
    const published = (entry.match(/<published>(.*?)<\/published>/) || [])[1] || "";
    if (id) {
      videos.push({
        id,
        title,
        url: `https://www.youtube.com/watch?v=${id}`,
        published,
      });
    }
  }
  return videos;
}

const DRAW_PATTERNS = [
  { regex: /^pick\s+mid/i,     type: "Pick Midday",   period: "m", emoji: "☀️" },
  { regex: /^pick\s+eve/i,     type: "Pick Evening",  period: "e", emoji: "🌙" },
  { regex: /pick\s*3.*mid/i,   type: "Pick 3 Midday", period: "m", emoji: "☀️" },
  { regex: /pick\s*3.*eve/i,   type: "Pick 3 Evening",period: "e", emoji: "🌙" },
  { regex: /pick\s*4.*mid/i,   type: "Pick 4 Midday", period: "m", emoji: "☀️" },
  { regex: /pick\s*4.*eve/i,   type: "Pick 4 Evening",period: "e", emoji: "🌙" },
];

function classifyVideo(title) {
  for (const pattern of DRAW_PATTERNS) {
    if (pattern.regex.test(title)) return pattern;
  }
  return null;
}

function captureFrame(videoUrl, videoId) {
  return new Promise((resolve, reject) => {
    const thumbnailPath = path.join(CAPTURE_DIR, `${videoId}_test_thumb.jpg`);
    
    // Strategy 1: Use yt-dlp to get the best thumbnail
    const thumbCmd = `yt-dlp --write-thumbnail --skip-download --convert-thumbnails jpg -o "${path.join(CAPTURE_DIR, videoId + '_test')}" "${videoUrl}" 2>&1`;

    console.log(`📸 [STEP 2] Attempting frame capture for video ID: ${videoId}`);
    console.log(`   Command: ${thumbCmd.substring(0, 100)}...`);

    exec(thumbCmd, { timeout: 60000 }, (err, stdout) => {
      // Find the file
      const possibleExtensions = ['.jpg', '.webp', '.png', '.jpeg'];
      let foundFile = null;
      for (const ext of possibleExtensions) {
        const fp = path.join(CAPTURE_DIR, `${videoId}_test${ext}`);
        if (fs.existsSync(fp)) {
          foundFile = fp;
          break;
        }
      }

      if (foundFile) {
        if (path.extname(foundFile) !== '.jpg') {
            // Rename to thumbPath if it exists or just keep it
        }
        console.log(`   ✅ Success! Captured: ${foundFile}`);
        return resolve(foundFile);
      }

      console.log(`   ⚠️  Thumbnail strategy failed. Checking if yt-dlp/ffmpeg are installed...`);
      exec("yt-dlp --version", (e1) => {
          if (e1) console.error("   ❌ yt-dlp is NOT installed or in PATH.");
          exec("ffmpeg -version", (e2) => {
              if (e2) console.error("   ❌ ffmpeg is NOT installed or in PATH.");
              reject(new Error("Capture failed: dependencies missing or download error"));
          });
      });
    });
  });
}

// ─── Main Logic ─────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🚀 RUNNING FULL CAPTURE TEST...");
  console.log("═══════════════════════════════════════════════════════\n");

  try {
    const xml = await fetchRSS(RSS_URL);
    const videos = parseRSSVideos(xml);
    console.log(`✅ [1/3] Found ${videos.length} videos in feed.\n`);

    // Find the latest "Pick" video
    const targetVideo = videos.find(v => classifyVideo(v.title));

    if (!targetVideo) {
      console.log("❌ [2/3] No recent 'Pick Midday' or 'Pick Evening' videos found in feed.");
      console.log("   Check the Florida Lottery channel manually to verify recent uploads.");
      return;
    }

    const draw = classifyVideo(targetVideo.title);
    console.log(`🎯 [2/3] Target identified:\n   Title: "${targetVideo.title}"\n   Type:  ${draw.type} [${draw.emoji}]\n   URL:   ${targetVideo.url}\n`);

    const imagePath = await captureFrame(targetVideo.url, targetVideo.id);
    console.log(`\n🎉 [3/3] TEST COMPLETE! Screenshot saved to:\n   ${imagePath}\n`);

  } catch (err) {
    console.error(`\n❌ TEST FAILED: ${err.message}`);
  }
}

main();
