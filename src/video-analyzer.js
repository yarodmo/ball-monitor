/**
 * VideoAnalyzer — AI-Powered Lottery Number Extraction (v3 BLISS APEX)
 * 
 * ARCHITECTURE:
 *   PRIMARY   → Full video upload to Gemini File API → single holistic analysis
 *   SECONDARY → Frame-by-frame vision analysis (voting consensus)
 *   TERTIARY  → Audio transcription cross-validation
 *   ORACLE    → Gemini Pro with all evidence combined (only if disagreement)
 * 
 * KEY CHANGES (v3):
 *   - REMOVED generateDateBlacklist (caused hallucinations via negative prompting)
 *   - ADDED Gemini File API upload for full-video temporal analysis
 *   - FIXED yt-dlp to force overwrite cached videos (--force-overwrites)
 *   - REWRITTEN prompts: positive reinforcement only, zero negation
 * 
 * @module video-analyzer
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// ─── Constants ──────────────────────────────────────────────────────────────
const WORK_DIR = path.join(__dirname, "../captures/analysis");
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD = "https://generativelanguage.googleapis.com/upload/v1beta";
const MAX_ANALYSES_TO_KEEP = 14;
const SCAN_INTERVAL_SEC = 3;
const VIDEO_DURATION_EST = 60;

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// ─── Utilities ──────────────────────────────────────────────────────────────
function getGeminiKey() {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY not set — cannot analyze video");
  return key;
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [VideoAnalyzer] ${msg}`);
}

function getFolderName(videoTitle) {
  const title = (videoTitle || "").toLowerCase();
  const dateMatch = title.match(/(\d{8})/);
  let dateStr = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10).replace(/-/g, "");
  let sessionChar = "M";
  if (title.includes("night") || title.includes("evening")) sessionChar = "E";
  else if (title.includes("midday")) sessionChar = "M";
  return `${dateStr}-${sessionChar}`;
}

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

// ─── Step 1: Download Video (FORCE OVERWRITE) ───────────────────────────────
async function downloadVideo(videoUrl, videoId, folderPath) {
  const mp4Path = path.join(folderPath, "source.mp4");
  
  // CRITICAL: Delete any cached video to force fresh download
  if (fs.existsSync(mp4Path)) {
    log(`🗑️  Deleting cached video to force fresh download...`);
    fs.unlinkSync(mp4Path);
  }

  log(`⬇️  Downloading video ${videoId} to ${mp4Path}...`);
  try {
    execSync(
      `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" ` +
      `--merge-output-format mp4 --force-overwrites ` +
      `--no-cache-dir ` +
      `-o "${mp4Path}" "${videoUrl}" 2>&1`,
      { timeout: 120000, stdio: "pipe" }
    );
  } catch (e) {
    throw new Error(`yt-dlp download failed: ${e.message}`);
  }

  if (!fs.existsSync(mp4Path)) throw new Error("Video download produced no file");
  const stats = fs.statSync(mp4Path);
  log(`✅ Video downloaded: ${mp4Path} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
  return mp4Path;
}

// ─── Step 2: Dynamic Frame Extraction ───────────────────────────────────────
function extractDynamicFrames(videoPath, folderPath) {
  log(`🖼️  Performing dynamic scan extraction...`);
  const frames = [];
  for (let sec = 5; sec < VIDEO_DURATION_EST; sec += SCAN_INTERVAL_SEC) {
    const label = `scan_${sec}s`;
    const framePath = path.join(folderPath, `frame_${label}.jpg`);
    const timestamp = `00:00:${String(sec).padStart(2, "0")}`;
    try {
      execSync(
        `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 "${framePath}" -y 2>&1`,
        { timeout: 30000, stdio: "pipe" }
      );
      if (fs.existsSync(framePath)) frames.push({ path: framePath, label, sec });
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

// ═══════════════════════════════════════════════════════════════════════════
// ─── GEMINI FILE API: Full Video Upload & Analysis ──────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Uploads a video file to Gemini File API via multipart/related upload.
 * Returns { name, uri, state } from the API response.
 */
async function uploadToGeminiFiles(videoPath) {
  const key = getGeminiKey();
  const videoBuffer = fs.readFileSync(videoPath);
  const displayName = path.basename(videoPath);
  log(`📤 Uploading video to Gemini File API (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)...`);

  const boundary = "BLISS_UPLOAD_" + Date.now();
  const metadata = JSON.stringify({ file: { displayName } });

  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`
  ];
  const bodyEnd = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(bodyParts[0]),
    Buffer.from(bodyParts[1]),
    videoBuffer,
    Buffer.from(bodyEnd)
  ]);

  return new Promise((resolve, reject) => {
    const url = new URL(`${GEMINI_UPLOAD}/files?key=${key}`);
    const opts = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "X-Goog-Upload-Protocol": "multipart",
        "Content-Length": body.length
      },
      timeout: 180000 // 3 minutes for upload
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          const file = parsed.file;
          log(`  ✅ Upload complete: ${file.name} (state: ${file.state})`);
          resolve(file);
        } else {
          reject(new Error(`File API upload failed [${res.statusCode}]: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("File API upload timed out")); });
    req.write(body);
    req.end();
  });
}

/**
 * Polls Gemini File API until the file state becomes ACTIVE.
 * Max 120 seconds polling (videos typically process in 10-30s).
 */
async function waitForFileActive(fileName) {
  const key = getGeminiKey();
  const maxWait = 120000; // 2 minutes
  const pollInterval = 5000; // 5 seconds
  const start = Date.now();

  log(`⏳ Waiting for Gemini to process video...`);

  while (Date.now() - start < maxWait) {
    const file = await new Promise((resolve, reject) => {
      const url = new URL(`${GEMINI_BASE}/${fileName}?key=${key}`);
      https.get({ hostname: url.hostname, path: url.pathname + url.search, timeout: 30000 }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          if (res.statusCode === 200) resolve(JSON.parse(data));
          else reject(new Error(`File status check failed [${res.statusCode}]: ${data}`));
        });
      }).on("error", reject);
    });

    if (file.state === "ACTIVE") {
      log(`  ✅ Video processed and ACTIVE (${((Date.now() - start) / 1000).toFixed(1)}s)`);
      return file;
    }
    if (file.state === "FAILED") {
      throw new Error(`Gemini video processing FAILED: ${JSON.stringify(file)}`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  throw new Error("Gemini video processing timed out after 120s");
}

/**
 * Deletes a file from Gemini File API (cleanup after analysis).
 */
async function deleteGeminiFile(fileName) {
  const key = getGeminiKey();
  try {
    await new Promise((resolve, reject) => {
      const url = new URL(`${GEMINI_BASE}/${fileName}?key=${key}`);
      const opts = { hostname: url.hostname, path: url.pathname + url.search, method: "DELETE", timeout: 15000 };
      const req = https.request(opts, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });
    log(`  🗑️  Cleaned up uploaded file: ${fileName}`);
  } catch (e) {
    log(`  ⚠️  File cleanup failed (non-critical): ${e.message}`);
  }
}

// ─── PRIMARY CHANNEL: Full Video Analysis ───────────────────────────────────

const FULL_VIDEO_PROMPT = `You are a forensic lottery number extraction system analyzing an official Florida Lottery drawing video.

VIDEO STRUCTURE (segments appear in this exact order):
1. Intro splash — Florida Lottery logo and draw date (IGNORE all text/numbers here)
2. Pick 2 drawing — 2 balls drawn (IGNORE this segment entirely)
3. Pick 3 drawing — 3 balls drawn → EXTRACT THESE 3 DIGITS
4. Pick 4 drawing — 4 balls drawn → EXTRACT THESE 4 DIGITS
5. Pick 5 drawing — 5 balls drawn (IGNORE this segment entirely)
6. Fireball drawing — 1 red ball (IGNORE this)
7. Final Summary Board — Lists all results in a graphic table (HIGHEST PRIORITY SOURCE)

EXTRACTION RULES:
- ONLY report numbers from the PICK 3 and PICK 4 segments
- The FINAL SUMMARY BOARD (blue/white results table shown at the end) is the GROUND TRUTH
- Each segment is introduced by an on-screen label: "Pick 2", "Pick 3", "Pick 4", "Pick 5"
- Balls have single digits (0-9) printed on them
- For 6 vs 9 disambiguation: look for the underline/dash mark on the ball
- COUNT the balls in each segment to confirm you're in the right game (3 balls = Pick 3, 4 balls = Pick 4)

Respond ONLY in valid JSON:
{"p3": "XXX", "p4": "XXXX"}
Where XXX is exactly 3 digits and XXXX is exactly 4 digits.`;

async function analyzeFullVideoWithGemini(videoPath) {
  log(`🎯 PRIMARY CHANNEL: Full Video Analysis via Gemini File API...`);
  
  let uploadedFile = null;
  try {
    // 1. Upload video
    uploadedFile = await uploadToGeminiFiles(videoPath);
    
    // 2. Wait for processing
    const activeFile = await waitForFileActive(uploadedFile.name);
    
    // 3. Analyze with full temporal context
    const key = getGeminiKey();
    const body = {
      contents: [{
        parts: [
          { text: FULL_VIDEO_PROMPT },
          { file_data: { mime_type: "video/mp4", file_uri: activeFile.uri } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
    };

    const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
    const response = await geminiPost(url, body);
    const result = parseGeminiNumbers(response, "full_video");
    
    log(`  🎯 Full Video Result: P3=${result.p3 || "?"} P4=${result.p4 || "?"}`);
    return result;
  } catch (e) {
    log(`  ⚠️ Full Video Analysis failed: ${e.message}`);
    return { p3: null, p4: null, is_summary: false };
  } finally {
    // Cleanup uploaded file
    if (uploadedFile?.name) {
      deleteGeminiFile(uploadedFile.name).catch(() => {});
    }
  }
}

// ─── SECONDARY CHANNEL: Frame-by-Frame Vision ──────────────────────────────

const FRAME_PROMPT_TEMPLATE = `FORENSIC LOTTERY FRAME ANALYZER
You are examining a single frame from an official Florida Lottery drawing video.
Frame timestamp: FRAME_CONTEXT

TASK: Extract Pick 3 (3 digits) and Pick 4 (4 digits) winning numbers ONLY.

WHAT TO LOOK FOR:
- Physical lottery balls inside transparent display tubes, each showing a single digit (0-9)
- A blue/white SUMMARY BOARD graphic listing all game results
- On-screen "Pick 3" or "Pick 4" labels identifying which game is shown

WHAT TO IGNORE:
- The intro date splash screen
- Pick 2, Pick 5, and Fireball results
- Any text that is NOT the lottery numbers (logos, dates, tickers)

For 6 vs 9: Look for the underline/dash mark on the ball face.
If this frame shows a FINAL SUMMARY BOARD with all games listed, mark is_summary as true.

Respond ONLY in valid JSON:
{"p3": "XXX", "p4": "XXXX", "is_summary": true/false}
Use null for values you cannot confidently read.`;

async function analyzeFrameWithGemini(imagePath, context) {
  const key = getGeminiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");
  const prompt = FRAME_PROMPT_TEMPLATE.replace("FRAME_CONTEXT", context);

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/jpeg", data: imageData } }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 100,
      responseMimeType: "application/json"
    }
  };

  // Use gemini-2.5-flash for frame analysis: faster, follows format instructions better
  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, context);
}

// ─── TERTIARY CHANNEL: Audio Transcription ──────────────────────────────────

async function analyzeAudioWithGemini(audioPath) {
  const key = getGeminiKey();
  const audioData = fs.readFileSync(audioPath).toString("base64");
  
  const prompt = `You are transcribing an official Florida Lottery drawing audio.
The announcer reads the winning numbers for each game in order: Pick 2, Pick 3, Pick 4, Pick 5, Fireball.

TASK: Listen carefully and extract ONLY the Pick 3 (3 digits) and Pick 4 (4 digits) winning numbers.
Pay careful attention to distinguish "six" from "nine" in the announcer's voice.

Respond ONLY in valid JSON:
{"p3": "XXX", "p4": "XXXX"}`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "audio/mpeg", data: audioData } }] }],
    generationConfig: { temperature: 0.1 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, "audio");
}

// ─── ORACLE: Emergency Dispute Resolution ───────────────────────────────────

async function analyzeOracleWithGeminiPro(framesBase64, audioBase64) {
  const key = getGeminiKey();
  
  const prompt = `SUPREME ORACLE — FINAL ARBITRATION

You are the final judge resolving a conflict between multiple AI channels analyzing a Florida Lottery drawing.

You are provided with:
1. Key video frames from throughout the drawing
2. The full audio track

CRITICAL INSTRUCTIONS:
- The video shows games in order: Pick 2 → Pick 3 → Pick 4 → Pick 5 → Fireball
- Look for the FINAL SUMMARY BOARD (blue/white results table) — this is absolute ground truth
- Count the physical balls in each segment: 3 balls = Pick 3, 4 balls = Pick 4
- For 6 vs 9: look for the underline mark on the ball face
- Cross-reference what you SEE with what you HEAR

Return ONLY the Pick 3 and Pick 4 results.
Respond in valid JSON: {"p3": "XXX", "p4": "XXXX"}`;

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

// ─── HTTP & Parsing Utilities ───────────────────────────────────────────────

async function geminiPost(url, body) {
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 20000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await _geminiPostSingle(url, body);
    } catch (e) {
      if (e.message.includes("429") && attempt < MAX_RETRIES) {
        const wait = BACKOFF_BASE_MS * attempt;
        log(`  ⏳ Quota limited. Retrying in ${wait / 1000}s...`);
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
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 120000 // 2 minutes for video analysis
    };
    const req = https.request(opts, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(d)) : reject(new Error(`API ${res.statusCode}: ${d}`)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gemini API request timed out")); });
    req.write(data);
    req.end();
  });
}

function parseGeminiNumbers(response, source) {
  try {
    const parts = response?.candidates?.[0]?.content?.parts || [];
    
    // Gemini 2.5 Flash/Pro uses "thinking" mode: parts[0] = thinking, parts[1+] = answer
    // Scan ALL parts for a JSON response, prioritizing non-thinking parts
    let jsonText = null;
    
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      // Skip thinking parts (they have thought: true)
      if (part.thought) continue;
      
      const text = part.text || "";
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        jsonText = match[0];
        break;
      }
    }
    
    // Fallback: if no non-thinking part had JSON, try ALL parts
    if (!jsonText) {
      for (const part of parts) {
        const text = part.text || "";
        const match = text.match(/\{[^}]+\}/);
        if (match) {
          jsonText = match[0];
          break;
        }
      }
    }

    if (!jsonText) {
      // Diagnostic: log what we actually received
      const preview = parts.map((p, i) => `part[${i}] thought=${!!p.thought} len=${(p.text||"").length}`).join(", ");
      log(`  🔍 [${source}] No JSON found in response. Parts: ${preview}`);
      return { p3: null, p4: null, is_summary: false };
    }
    
    const p = JSON.parse(jsonText);
    return {
      p3: p.p3 ? String(p.p3).replace(/\D/g, "") : null,
      p4: p.p4 ? String(p.p4).replace(/\D/g, "") : null,
      is_summary: p.is_summary || false
    };
  } catch (e) {
    log(`  ⚠️ [${source}] Parse error: ${e.message}`);
    return { p3: null, p4: null, is_summary: false };
  }
}

// ─── Cross-Validation Engine ────────────────────────────────────────────────

function crossValidateAllChannels(fullVideoResult, visionResults, audioResult) {
  log(`🔬 CROSS-VALIDATING ALL CHANNELS...`);
  log(`  📹 Full Video:  P3=${fullVideoResult.p3 || "?"} P4=${fullVideoResult.p4 || "?"}`);

  // Frame voting
  const p3Votes = {};
  const p4Votes = {};
  for (const vr of visionResults) {
    const weight = vr.is_summary ? 10 : 1;
    if (vr.p3 && vr.p3.length === 3) p3Votes[vr.p3] = (p3Votes[vr.p3] || 0) + weight;
    if (vr.p4 && vr.p4.length === 4) p4Votes[vr.p4] = (p4Votes[vr.p4] || 0) + weight;
  }
  const frameP3 = Object.entries(p3Votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const frameP4 = Object.entries(p4Votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  log(`  🖼️  Frame Vote:  P3=${frameP3 || "?"} P4=${frameP4 || "?"}`);
  log(`  🔊 Audio:       P3=${audioResult.p3 || "?"} P4=${audioResult.p4 || "?"}`);

  // Agreement scoring: Full Video has highest authority
  let finalP3, finalP4, confidence;

  // P3 resolution
  const p3Sources = [fullVideoResult.p3, frameP3, audioResult.p3].filter(Boolean);
  const p3Agreement = {};
  p3Sources.forEach(v => { p3Agreement[v] = (p3Agreement[v] || 0) + 1; });
  const p3Best = Object.entries(p3Agreement).sort((a, b) => b[1] - a[1])[0];

  // P4 resolution
  const p4Sources = [fullVideoResult.p4, frameP4, audioResult.p4].filter(Boolean);
  const p4Agreement = {};
  p4Sources.forEach(v => { p4Agreement[v] = (p4Agreement[v] || 0) + 1; });
  const p4Best = Object.entries(p4Agreement).sort((a, b) => b[1] - a[1])[0];

  // If 2+ channels agree, that's our answer
  if (p3Best && p3Best[1] >= 2) {
    finalP3 = p3Best[0];
  } else {
    // Trust Full Video over individual channels
    finalP3 = fullVideoResult.p3 || frameP3 || audioResult.p3;
  }

  if (p4Best && p4Best[1] >= 2) {
    finalP4 = p4Best[0];
  } else {
    finalP4 = fullVideoResult.p4 || frameP4 || audioResult.p4;
  }

  // Confidence level
  const p3Unanimous = p3Best && p3Best[1] === p3Sources.length && p3Sources.length >= 2;
  const p4Unanimous = p4Best && p4Best[1] === p4Sources.length && p4Sources.length >= 2;

  if (p3Unanimous && p4Unanimous) {
    confidence = "high";
  } else if ((p3Best && p3Best[1] >= 2) && (p4Best && p4Best[1] >= 2)) {
    confidence = "high";
  } else {
    confidence = "medium";
  }

  log(`  ✅ CROSS-VALIDATED: P3=${finalP3 || "?"} P4=${finalP4 || "?"} [${confidence.toUpperCase()}]`);
  return { p3: finalP3, p4: finalP4, confidence };
}

function findGoldFrame(frames, visionResults) {
  const summaryIdx = visionResults.findIndex(r => r.is_summary);
  if (summaryIdx !== -1) return frames[summaryIdx].path;
  const resultsIdx = visionResults.findIndex(r => r.p3 && r.p4);
  if (resultsIdx !== -1) return frames[resultsIdx].path;
  const sweetSpot = frames.find(f => f.sec >= 36 && f.sec <= 45);
  if (sweetSpot) return sweetSpot.path;
  return frames[frames.length - 1]?.path;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────
async function analyzeVideo(videoUrl, videoId, videoTitle) {
  log(`🎬 PROCESANDO SORTEO: "${videoTitle}"`);
  log(`🏗️  Pipeline v3.2 APEX: Parallel (FullVideo + Audio) → [Frames if needed] → Oracle`);

  const folderName = getFolderName(videoTitle);
  const folderPath = path.join(WORK_DIR, folderName);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  // Step 1: Download (FORCE fresh)
  const videoPath = await downloadVideo(videoUrl, videoId, folderPath);

  // Step 2: Extract audio (fast, ~0.8s)
  const audioPath = extractAudio(videoPath, folderPath);

  // ═══ PHASE 1: Primary Channels (Full Video + Audio) IN PARALLEL ═══
  log(`⚡ Ejecutando Gemini FullVideo y Audio Transcription en paralelo...`);
  const [fullVideoResult, audioResultOrNull] = await Promise.all([
    analyzeFullVideoWithGemini(videoPath),
    audioPath ? analyzeAudioWithGemini(audioPath).catch(e => {
      log(`⚠️ Gemini Audio error: ${e.message}`);
      return { p3: null, p4: null };
    }) : Promise.resolve({ p3: null, p4: null })
  ]);
  const audioResult = audioResultOrNull || { p3: null, p4: null };

  // Quick check: do primary channels agree?
  const primaryAgree = (
    fullVideoResult.p3 && fullVideoResult.p4 &&
    audioResult.p3 && audioResult.p4 &&
    fullVideoResult.p3 === audioResult.p3 &&
    fullVideoResult.p4 === audioResult.p4
  );

  let visionResults = [];
  let strategicFrames = [];
  let frames = [];
  let goldFrame = null;

  if (primaryAgree) {
    log(`🎯 PRIMARY CHANNELS AGREE — Skipping full frame extraction (saving ~72s!)`);
    // Extract a single quick cover frame for the push payload (e.g. at 48s)
    const goldPath = path.join(folderPath, `frame_scan_48s.jpg`);
    try {
      execSync(`ffmpeg -i "${videoPath}" -ss 00:00:48 -vframes 1 -q:v 2 "${goldPath}" -y 2>&1`, { timeout: 10000 });
      if (fs.existsSync(goldPath)) goldFrame = goldPath;
    } catch(e) {
      log(`⚠️ Failed to extract quick cover frame: ${e.message}`);
    }
  } else {
    // ═══ PHASE 2: Frame Analysis (Tiebreaker) ═══
    log(`⚠️ Primary channels disagree! Extrayendo frames completos como tiebreaker...`);
    frames = extractDynamicFrames(videoPath, folderPath);
    
    strategicFrames = frames.filter(f =>
      (f.sec >= 14 && f.sec <= 26) || // Pick 3 segment
      (f.sec >= 26 && f.sec <= 40) || // Pick 4 segment
      (f.sec >= 47 && f.sec <= 56)    // Summary board
    );
    log(`🖼️  Analyzing ${strategicFrames.length} strategic frames (of ${frames.length} total)...`);

    for (const f of strategicFrames) {
      try {
        const res = await analyzeFrameWithGemini(f.path, f.label);
        visionResults.push(res);
      } catch (e) {
        log(`⚠️ Gemini Vision error on ${f.label}: ${e.message}`);
      }
    }
    
    goldFrame = findGoldFrame(strategicFrames.length ? strategicFrames : frames, visionResults);
  }

  // ═══ CROSS-VALIDATION ═══
  let validated = crossValidateAllChannels(fullVideoResult, visionResults, audioResult);

  // ═══ ORACLE (Emergency only — when confidence is not HIGH) ═══
  if (validated.confidence !== "high") {
    log(`⚠️ Confidence is MEDIUM. Triggering EMERGENCY ORACLE (Gemini 2.5 Pro)...`);
    try {
      const oracleFrames = strategicFrames.length ? strategicFrames : frames.filter(f => f.sec >= 14 && f.sec <= 56);
      const framesB64 = oracleFrames.length > 0 ? oracleFrames.map(f => fs.readFileSync(f.path).toString("base64")) : [];
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

  cleanupOldAnalyses();

  return { ...validated, source: "bliss_forensic_pipeline_v3.2", folder: folderPath, goldFrame };
}

module.exports = { analyzeVideo, cleanupAnalysis: cleanupOldAnalyses };
