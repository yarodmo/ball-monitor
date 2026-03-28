/**
 * VideoAnalyzer — AI-Powered Lottery Number Extraction
 * 
 * Downloads FL Lottery YouTube videos, extracts key frames + audio,
 * then uses Gemini Vision + Audio APIs to read the winning numbers.
 * 
 * ZERO dependency on PDF scrapers. Numbers come directly from the video.
 * Dual-source validation: Vision (frame OCR) ↔ Audio (transcription).
 * 
 * @module video-analyzer
 */

const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// ─── Constants ──────────────────────────────────────────────────────────────
const WORK_DIR = path.join(__dirname, "../captures/analysis");
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_ANALYSES_TO_KEEP = 14; // 7 days * 2 sessions

// ─── Dynamic Sampling ───────────────────────────────────────────────────────
// Instead of hard-coded 18s/35s which vary, we scan the whole video.
const SCAN_INTERVAL_SEC = 3; // 3s granularity for forensic veracity
const VIDEO_DURATION_EST = 60; 

// ─── Ensure Work Directory ──────────────────────────────────────────────────
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ─── Step 0: Utilities ───────────────────────────────────────────────────────
function getGeminiKey() {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY not set — cannot analyze video");
  return key;
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [VideoAnalyzer] ${msg}`);
}

/**
 * Parses video title to determine YYYYMMDD-X folder name (M=Midday, E=Evening).
 */
function getFolderName(videoTitle) {
  const title = (videoTitle || "").toLowerCase();
  
  // 1. Try to find YYYYMMDD in title (e.g., "Pick Evening 20260324")
  const dateMatch = title.match(/(\d{8})/);
  let dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10).replace(/-/g, "");

  // 2. Identify Session
  let sessionChar = "M";
  if (title.includes("night") || title.includes("evening")) {
    sessionChar = "E";
  } else if (title.includes("midday")) {
    sessionChar = "M";
  }

  return `${dateStr}-${sessionChar}`;
}

/**
 * Cleans up old subfolders to keep exactly MAX_ANALYSES_TO_KEEP.
 */
function cleanupOldAnalyses() {
  const folders = fs.readdirSync(WORK_DIR)
    .map(name => ({ name, path: path.join(WORK_DIR, name), stats: fs.statSync(path.join(WORK_DIR, name)) }))
    .filter(f => f.stats.isDirectory())
    .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);

  if (folders.length > MAX_ANALYSES_TO_KEEP) {
    log(`🧹 Pruning ${folders.length - MAX_ANALYSES_TO_KEEP} old analyses...`);
    for (let i = MAX_ANALYSES_TO_KEEP; i < folders.length; i++) {
        fs.rmSync(folders[i].path, { recursive: true, force: true });
        log(`   🗑️  Deleted: ${folders[i].name}`);
    }
  }
}

// ─── Step 1: Download Video ─────────────────────────────────────────────────
async function downloadVideo(videoUrl, videoId, folderPath) {
  const mp4Path = path.join(folderPath, "source.mp4");
  
  log(`⬇️  Downloading video ${videoId} to ${mp4Path}...`);
  try {
    execSync(
      `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
      `--merge-output-format mp4 ` +
      `-o "${mp4Path}" "${videoUrl}" 2>&1`,
      { timeout: 120000, stdio: "pipe" }
    );
  } catch (e) {
    throw new Error(`yt-dlp download failed: ${e.message}`);
  }

  log(`✅ Video downloaded: ${mp4Path}`);
  return mp4Path;
}

// ─── Step 2: Dynamic Frame Extraction ───────────────────────────────────────
function extractDynamicFrames(videoPath, folderPath) {
  log(`🖼️  Performing a dynamic scan extraction...`);
  const frames = [];
  
  // Rule: Sample every 5 seconds to catch whatever board appears.
  for (let sec = 5; sec < VIDEO_DURATION_EST; sec += SCAN_INTERVAL_SEC) {
    const label = `scan_${sec}s`;
    const framePath = path.join(folderPath, `frame_${label}.jpg`);
    const timestamp = `00:00:${String(sec).padStart(2, "0")}`;

    try {
      execSync(
        `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 "${framePath}" -y 2>&1`,
        { timeout: 30000, stdio: "pipe" }
      );
      if (fs.existsSync(framePath)) {
        frames.push({ path: framePath, label, sec });
      }
    } catch (e) {
      log(`  ⚠️  Frame extraction at ${sec}s skipped.`);
    }
  }

  return frames;
}

// ─── Step 3: Extract Audio ──────────────────────────────────────────────────
function extractAudio(videoPath, folderPath) {
  const audioPath = path.join(folderPath, `audio.mp3`);
  log(`🔊 Extracting audio track...`);
  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 "${audioPath}" -y 2>&1`,
      { timeout: 30000, stdio: "pipe" }
    );
  } catch (e) {
    log(`⚠️  Audio extraction failed.`);
  }
  return fs.existsSync(audioPath) ? audioPath : null;
}

// ─── Step 4: Analysis & Cross-Validation ─────────────────────────────────────
// (Keep existing Gemini functions but adjust crossValidate to handle dynamic results)

async function analyzeFrameWithGemini(imagePath, context) {
  const key = getGeminiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");
  
  const prompt = `FORENSIC LOTTERY ANALYZER
Context: A frame from an official FL Lottery video (${context}).

TASK: Extract Pick 3 and Pick 4 numbers.
1. Look for results boards (blue/white graphics) or physical ball tubes.
2. DISAMBIGUATION: PHYSICAL BALLS for 6 and 9 have ULTIMATE PROOF: a small dash/underline at the loop (6) or stem (9). Identify the dash!
3. If this is a FINAL SUMMARY BOARD (lists all drawings like Pick 2, 3, 4, 5 and Fireball), consider it PRIMARY GROUND TRUTH.

RESPOND ONLY IN JSON:
{"p3": "XXX", "p4": "XXXX", "is_summary": boolean}
(Use null for unreadable values)`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: imageData } }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 100 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, context);
}

async function analyzeAudioWithGemini(audioPath) {
  const key = getGeminiKey();
  const audioData = fs.readFileSync(audioPath).toString("base64");
  const prompt = `AUDIO AUDITOR: Transcribe Pick 3 and Pick 4 winning numbers. Distinguish 6 vs 9 carefully. 
Output JSON: {"p3": "XXX", "p4": "XXXX"}`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "audio/mpeg", data: audioData } }] }],
    generationConfig: { temperature: 0.1 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, "audio");
}

async function analyzeOracleWithGeminiPro(framesBase64, audioBase64) {
  const key = getGeminiKey();
  const prompt = `SUPREME ORACLE: You are verifying a FL Lottery draw. The previous extraction had conflicting audio/video. We provide key frames throughout the video, plus the audio track. Determine the definitive Pick 3 and Pick 4 numbers from the final summary board. Return JSON: {"p3": "XXX", "p4": "XXXX"}`;
  
  const parts = [{ text: prompt }];
  for (const f of framesBase64) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: f } });
  }
  if (audioBase64) {
    parts.push({ inline_data: { mime_type: "audio/mpeg", data: audioBase64 } });
  }

  const body = {
    contents: [{ parts }],
    generationConfig: { temperature: 0.1 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-pro:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, "oracle");
}

async function geminiPost(url, body) {
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 20000; // Increased backoff for Bliss Protocols

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _geminiPostSingle(url, body);
    } catch (e) {
      if (e.message.includes("429") && attempt < MAX_RETRIES) {
        const wait = BACKOFF_BASE_MS * attempt;
        log(`  ⏳ Quota limited. Retrying in ${wait/1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
}

function _geminiPostSingle(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 60000
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error(`API ${res.statusCode}: ${d}`)));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

function parseGeminiNumbers(response, source) {
  try {
    const text = response?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = text.match(/\{[^}]+\}/);
    if (!match) return { p3: null, p4: null, is_summary: false };
    const p = JSON.parse(match[0]);
    return { 
      p3: p.p3 ? String(p.p3).replace(/\D/g, "") : null,
      p4: p.p4 ? String(p.p4).replace(/\D/g, "") : null,
      is_summary: p.is_summary || false 
    };
  } catch (e) { return { p3: null, p4: null, is_summary: false }; }
}

function crossValidate(visionResults, audioResult) {
  log(`🔬 Triangulating Results (Summary Board + Dynamic Frames + Audio)...`);

  const p3Votes = {}; const p4Votes = {};
  
  for (const vr of visionResults) {
    const weight = vr.is_summary ? 10 : 1; // Summary board is near-absolute
    if (vr.p3 && vr.p3.length === 3) p3Votes[vr.p3] = (p3Votes[vr.p3] || 0) + weight;
    if (vr.p4 && vr.p4.length === 4) p4Votes[vr.p4] = (p4Votes[vr.p4] || 0) + weight;
  }

  const visionP3 = Object.entries(p3Votes).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
  const visionP4 = Object.entries(p4Votes).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
  
  // Final resolution: Audio as absolute ground truth auditor
  const finalP3 = (visionP3 && audioResult.p3 && visionP3 === audioResult.p3) ? visionP3 : (audioResult.p3 || visionP3);
  const finalP4 = (visionP4 && audioResult.p4 && visionP4 === audioResult.p4) ? visionP4 : (audioResult.p4 || visionP4);
  
  const confidence = (finalP3 && finalP4 && visionP3 === audioResult.p3 && visionP4 === audioResult.p4) ? "high" : "medium";
  log(`  ✅ FINAL CONFIRMED: P3=${finalP3 || "?"} P4=${finalP4 || "?"} [${confidence.toUpperCase()}]`);

  return { p3: finalP3, p4: finalP4, confidence };
}

function findGoldFrame(frames, visionResults) {
  // 1. Prefer the frame identified as "summary board"
  const summaryIdx = visionResults.findIndex(r => r.is_summary);
  if (summaryIdx !== -1) return frames[summaryIdx].path;

  // 2. Fallback: Prefer a frame where both P3 and P4 were detected (likely results board)
  const resultsIdx = visionResults.findIndex(r => r.p3 && r.p4);
  if (resultsIdx !== -1) return frames[resultsIdx].path;

  // 3. Last fallback: pick a frame around 36-45 seconds (sweet spot for results in 1min videos)
  const sweetSpot = frames.find(f => f.sec >= 36 && f.sec <= 45);
  if (sweetSpot) return sweetSpot.path;

  // 4. Absolute fallback: the most recent frame
  return frames[frames.length - 1]?.path;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────
async function analyzeVideo(videoUrl, videoId, videoTitle) {
  log(`🎬 PROCESANDO SORTEO: "${videoTitle}"`);
  
  const folderName = getFolderName(videoTitle);
  const folderPath = path.join(WORK_DIR, folderName);
  
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  const videoPath = await downloadVideo(videoUrl, videoId, folderPath);
  const frames = extractDynamicFrames(videoPath, folderPath);
  const audioPath = extractAudio(videoPath, folderPath);

  const visionResults = [];
  for (const f of frames) {
    try {
      const res = await analyzeFrameWithGemini(f.path, f.label);
      visionResults.push(res);
    } catch (e) {
      log(`⚠️ Gemini Vision error on ${f.label}: ${e.message}`);
    }
  }

  let audioResult = { p3: null, p4: null };
  if (audioPath) {
    try { 
      audioResult = await analyzeAudioWithGemini(audioPath); 
    } catch (e) {
      log(`⚠️ Gemini Audio error: ${e.message}`);
    }
  }

  let validated = crossValidate(visionResults, audioResult);
  
  if (validated.confidence !== "high") {
    log(`⚠️ Confidence is MEDIUM/LOW. Triggering EMERGENCY ORACLE (Gemini 2.5 Pro)...`);
    try {
      const framesB64 = frames.map(f => fs.readFileSync(f.path).toString("base64"));
      const audioB64 = audioPath ? fs.readFileSync(audioPath).toString("base64") : null;
      const oracleResult = await analyzeOracleWithGeminiPro(framesB64, audioB64);
      if (oracleResult.p3 && oracleResult.p4) {
        validated.p3 = oracleResult.p3;
        validated.p4 = oracleResult.p4;
        validated.confidence = "high_oracle_validated";
        log(`  🏆 ORACLE RESOLVED: P3=${validated.p3} P4=${validated.p4}`);
      } else {
        log(`  ⚠️ ORACLE could not resolve numbers firmly.`);
      }
    } catch (e) {
      log(`  ⚠️ Oracle API Error: ${e.message}`);
    }
  }

  const goldFrame = findGoldFrame(frames, visionResults);

  // Per user request: keep last 14, delete the rest
  cleanupOldAnalyses();

  return { ...validated, source: "bliss_forensic_pipeline", folder: folderPath, goldFrame };
}

module.exports = { analyzeVideo, cleanupAnalysis: cleanupOldAnalyses };
