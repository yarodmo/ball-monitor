/**
 * VideoAnalyzer — AI-Powered Lottery Number Extraction (v4 IRONCLAD)
 * 
 * ARCHITECTURE:
 *   PRIMARY   → Audio transcription (announcer says each digit clearly)
 *   SECONDARY → Summary Board frames (printed text at end of video, 48-55s)
 * 
 *   NO full video upload (saves 30s+ upload/processing)
 *   NO shotgun 17-frame extraction (saves 12+ API calls)
 *   NO Oracle/Gemini Pro (introduced errors, never corrected any)
 * 
 * Audio is ground truth. Summary Board is confirmation.
 * 
 * HISTORICAL JUSTIFICATION:
 *   - Oracle confirmed date-as-numbers hallucination (20260330-M)
 *   - Oracle introduced 6→9 error overriding correct audio (20260401-M)
 *   - Oracle never corrected a single error in 3 invocations (0/3)
 *   - Vision (Gemini 2.5 Flash) intermittently returns text instead of JSON
 *   - Audio correctly identified numbers in ALL documented cases
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
const MAX_ANALYSES_TO_KEEP = 14;

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

// ─── Step 2: Extract Audio ──────────────────────────────────────────────────
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

// ─── Step 3: Extract Summary Board Frames (targeted, 48-55s) ────────────────
function extractSummaryBoardFrames(videoPath, folderPath) {
  log(`🖼️  Extracting Summary Board frames (48-55s window)...`);
  const frames = [];
  // The Summary Board appears at the end of the video, typically 48-55s.
  // It's a PRINTED GRAPHIC with digital text — immune to 6/9 ball confusion.
  const timestamps = [48, 51, 54];

  for (const sec of timestamps) {
    const framePath = path.join(folderPath, `frame_summary_${sec}s.jpg`);
    const timestamp = `00:00:${String(sec).padStart(2, "0")}`;
    try {
      execSync(
        `ffmpeg -i "${videoPath}" -ss ${timestamp} -vframes 1 -q:v 2 "${framePath}" -y 2>&1`,
        { timeout: 30000, stdio: "pipe" }
      );
      if (fs.existsSync(framePath)) {
        frames.push({ path: framePath, label: `summary_${sec}s`, sec });
      }
    } catch (e) {
      log(`  ⚠️  Frame extraction at ${sec}s skipped.`);
    }
  }

  log(`  ✅ Extracted ${frames.length} summary board frames`);
  return frames;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── PRIMARY CHANNEL: Audio Transcription ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const AUDIO_PROMPT = `You are transcribing an official Florida Lottery drawing audio.
The announcer reads the winning numbers for each game in order: Pick 2, Pick 3, Pick 4, Pick 5, Fireball.

TASK: Listen carefully and extract ONLY the Pick 3 (3 digits) and Pick 4 (4 digits) winning numbers.

CRITICAL DIGIT DISAMBIGUATION:
- "SIX" sounds like /sɪks/ — one syllable, ends with a hard "ks" sound
- "NINE" sounds like /naɪn/ — starts with an "n" sound, ends with an "n" sound
- "FIVE" sounds like /faɪv/ — starts with an "f" sound, ends with "v"
- "FOUR" sounds like /fɔːr/ — starts with an "f" sound, ends with "r"
- The announcer clearly and deliberately enunciates each individual digit
- Trust EXACTLY what you hear — do not guess or infer from context

STRUCTURE: The announcer says something like:
"The Pick 3 winning numbers are [digit], [digit], [digit]"
"The Pick 4 winning numbers are [digit], [digit], [digit], [digit]"

Respond ONLY in valid JSON, nothing else:
{"p3": "XXX", "p4": "XXXX"}`;

async function analyzeAudioWithGemini(audioPath) {
  log(`🔊 PRIMARY CHANNEL: Audio Transcription (Ground Truth)...`);
  const key = getGeminiKey();
  const audioData = fs.readFileSync(audioPath).toString("base64");

  const body = {
    contents: [{ parts: [{ text: AUDIO_PROMPT }, { inline_data: { mime_type: "audio/mpeg", data: audioData } }] }],
    generationConfig: { temperature: 0.1 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  const result = parseGeminiNumbers(response, "audio");
  log(`  🔊 Audio Result: P3=${result.p3 || "?"} P4=${result.p4 || "?"}`);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SECONDARY CHANNEL: Summary Board Vision ───────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const SUMMARY_BOARD_PROMPT = `FORENSIC SUMMARY BOARD READER

You are examining a frame from the END of an official Florida Lottery drawing video.
This frame should show the FINAL SUMMARY BOARD — a blue/white graphic table listing all game results.

TASK: Read the Pick 3 (3 digits) and Pick 4 (4 digits) winning numbers from the summary board.

WHAT TO LOOK FOR:
- A blue/white SUMMARY TABLE graphic showing results for all games
- The rows labeled "Pick 3" and "Pick 4" with their winning numbers
- This is PRINTED TEXT on a graphic overlay, NOT physical lottery balls
- The numbers are displayed as clean digital text — no ball rotation ambiguity

WHAT TO IGNORE:
- Pick 2, Pick 5, and Fireball results
- Any logos, dates, or decorative elements

If this frame does NOT show a summary board (e.g., it shows balls being drawn, an intro screen, 
or credits), set both values to null and is_summary to false.

Respond ONLY in valid JSON, nothing else:
{"p3": "XXX", "p4": "XXXX", "is_summary": true}

Use null for values you cannot read. Set is_summary to false if no summary board is visible.`;

async function analyzeSummaryBoardFrame(imagePath, context) {
  const key = getGeminiKey();
  const imageData = fs.readFileSync(imagePath).toString("base64");

  const body = {
    contents: [{ parts: [{ text: SUMMARY_BOARD_PROMPT }, { inline_data: { mime_type: "image/jpeg", data: imageData } }] }],
    generationConfig: { temperature: 0.1 }
  };

  const url = `${GEMINI_BASE}/models/gemini-2.5-flash:generateContent?key=${key}`;
  const response = await geminiPost(url, body);
  return parseGeminiNumbers(response, context);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── HTTP & Parsing Utilities ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

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
      timeout: 120000
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

    // Strategy 1: Find JSON in non-thinking parts (Gemini 2.5 uses thinking mode)
    let jsonText = null;

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (part.thought) continue; // Skip thinking parts

      const text = part.text || "";
      const match = text.match(/\{[^}]+\}/);
      if (match) {
        jsonText = match[0];
        break;
      }
    }

    // Strategy 2: Fallback — try ALL parts including thinking
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

    // Strategy 3: Plaintext fallback — extract numbers from non-JSON responses
    if (!jsonText) {
      const allText = parts.map(p => p.text || "").join(" ");
      const preview = parts.map((p, i) => `part[${i}] thought=${!!p.thought} len=${(p.text || "").length}`).join(", ");
      log(`  🔍 [${source}] No JSON found. Parts: ${preview}`);
      log(`  🔍 [${source}] Attempting plaintext extraction from: "${allText.substring(0, 120)}"`);
      return extractNumbersFromPlaintext(allText, source);
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

/**
 * Extracts P3 (3-digit) and P4 (4-digit) numbers from plaintext responses.
 * Handles cases where Gemini returns text instead of JSON:
 *   "Pick 3: 726, Pick 4: 5787"
 *   "P3=726 P4=5787"
 *   "The numbers are 726 and 5787"
 *   "726 5787"
 */
function extractNumbersFromPlaintext(text, source) {
  let p3 = null;
  let p4 = null;

  // Pattern 1: Labeled "Pick 3: 726" or "P3: 726" or "P3=726"
  const p3Match = text.match(/(?:pick\s*3|p3)\s*[:=\s]\s*(\d{3})\b/i);
  const p4Match = text.match(/(?:pick\s*4|p4)\s*[:=\s]\s*(\d{4})\b/i);
  if (p3Match) p3 = p3Match[1];
  if (p4Match) p4 = p4Match[1];

  // Pattern 2: Standalone 3-digit and 4-digit numbers
  if (!p3 || !p4) {
    const allNumbers = text.match(/\b\d{3,4}\b/g) || [];
    for (const num of allNumbers) {
      if (num.length === 3 && !p3) p3 = num;
      else if (num.length === 4 && !p4) p4 = num;
    }
  }

  if (p3 || p4) {
    log(`  ✅ [${source}] Plaintext extraction: P3=${p3 || "?"} P4=${p4 || "?"}`);
  } else {
    log(`  ❌ [${source}] Plaintext extraction failed — no valid numbers found`);
  }

  return { p3, p4, is_summary: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Cross-Validation Engine (Audio-First Authority) ────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

function crossValidate(audioResult, summaryResults) {
  log(`🔬 CROSS-VALIDATION: Audio (PRIMARY) + Summary Board (CONFIRMATION)`);
  log(`  🔊 Audio:         P3=${audioResult.p3 || "?"} P4=${audioResult.p4 || "?"}`);

  // Aggregate Summary Board results with weighted voting
  const p3Votes = {};
  const p4Votes = {};
  for (const sr of summaryResults) {
    // Frames that detected a summary board get 10x weight
    const weight = sr.is_summary ? 10 : 1;
    if (sr.p3 && sr.p3.length === 3) p3Votes[sr.p3] = (p3Votes[sr.p3] || 0) + weight;
    if (sr.p4 && sr.p4.length === 4) p4Votes[sr.p4] = (p4Votes[sr.p4] || 0) + weight;
  }

  const summaryP3 = Object.entries(p3Votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const summaryP4 = Object.entries(p4Votes).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  log(`  🖼️  Summary Board: P3=${summaryP3 || "?"} P4=${summaryP4 || "?"}`);

  let finalP3, finalP4, confidence;

  // ═══ DECISION LOGIC: Audio is the authority ═══

  // CASE 1: Audio produced results (most common path)
  if (audioResult.p3 && audioResult.p4) {
    if (summaryP3 && summaryP4) {
      // Both channels have data
      if (audioResult.p3 === summaryP3 && audioResult.p4 === summaryP4) {
        // PERFECT MATCH — highest confidence
        finalP3 = audioResult.p3;
        finalP4 = audioResult.p4;
        confidence = "high";
        log(`  ✅ PERFECT MATCH: Audio + Summary Board agree → HIGH confidence`);
      } else {
        // DISAGREEMENT — Audio wins (historically more reliable)
        finalP3 = audioResult.p3;
        finalP4 = audioResult.p4;
        confidence = "high_audio_authority";

        // Log forensic details for each disagreement
        if (audioResult.p3 !== summaryP3) {
          log(`  ⚠️ P3 CONFLICT: Audio="${audioResult.p3}" vs Summary="${summaryP3}" → TRUSTING AUDIO`);
          // Detect specific 6/9 conflicts
          for (let i = 0; i < 3; i++) {
            const a = audioResult.p3[i], s = (summaryP3 || "")[i];
            if ((a === '6' && s === '9') || (a === '9' && s === '6')) {
              log(`  🔥 6/9 CONFLICT at P3 digit ${i + 1}: Audio='${a}' Summary='${s}' → Audio WINS (phonetically unambiguous)`);
            }
          }
        }
        if (audioResult.p4 !== summaryP4) {
          log(`  ⚠️ P4 CONFLICT: Audio="${audioResult.p4}" vs Summary="${summaryP4}" → TRUSTING AUDIO`);
          for (let i = 0; i < 4; i++) {
            const a = audioResult.p4[i], s = (summaryP4 || "")[i];
            if ((a === '6' && s === '9') || (a === '9' && s === '6')) {
              log(`  🔥 6/9 CONFLICT at P4 digit ${i + 1}: Audio='${a}' Summary='${s}' → Audio WINS (phonetically unambiguous)`);
            }
          }
        }
      }
    } else {
      // Only Audio has data — Summary Board failed or showed no board
      finalP3 = audioResult.p3;
      finalP4 = audioResult.p4;
      confidence = "high_audio_only";
      log(`  ✅ AUDIO ONLY: Summary Board had no usable data → Trusting audio (PRIMARY channel)`);
    }
  }
  // CASE 2: Audio failed, but Summary Board has data
  else if (summaryP3 && summaryP4) {
    finalP3 = summaryP3;
    finalP4 = summaryP4;
    confidence = "medium_vision_only";
    log(`  ⚠️ AUDIO FAILED: Using Summary Board as fallback → MEDIUM confidence`);
  }
  // CASE 3: Both channels failed
  else {
    finalP3 = audioResult.p3 || summaryP3;
    finalP4 = audioResult.p4 || summaryP4;
    confidence = "low";
    log(`  ❌ BOTH CHANNELS WEAK: Partial/no data → LOW confidence`);
  }

  log(`  🏆 FINAL: P3=${finalP3 || "?"} P4=${finalP4 || "?"} [${confidence.toUpperCase()}]`);
  return { p3: finalP3, p4: finalP4, confidence };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── Main Entry Point ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

async function analyzeVideo(videoUrl, videoId, videoTitle) {
  log(`🎬 ═══════════════════════════════════════════════════════════════`);
  log(`🎬 PROCESANDO SORTEO: "${videoTitle}"`);
  log(`🏗️  Pipeline v4 IRONCLAD: Audio (PRIMARY) + Summary Board (CONFIRMATION)`);
  log(`🎬 ═══════════════════════════════════════════════════════════════`);

  const folderName = getFolderName(videoTitle);
  const folderPath = path.join(WORK_DIR, folderName);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

  // Step 1: Download (FORCE fresh)
  const videoPath = await downloadVideo(videoUrl, videoId, folderPath);

  // Step 2: Extract audio + summary board frames (both fast, local ffmpeg)
  log(`⚡ Extracting audio + summary board frames...`);
  const audioPath = extractAudio(videoPath, folderPath);
  const summaryFrames = extractSummaryBoardFrames(videoPath, folderPath);

  // Step 3: Analyze Audio + Summary Board IN PARALLEL (max efficiency)
  log(`⚡ Analyzing Audio + Summary Board in parallel via Gemini...`);
  const audioPromise = audioPath
    ? analyzeAudioWithGemini(audioPath).catch(e => {
      log(`⚠️ Audio analysis error: ${e.message}`);
      return { p3: null, p4: null };
    })
    : Promise.resolve({ p3: null, p4: null });

  const summaryPromises = summaryFrames.map(f =>
    analyzeSummaryBoardFrame(f.path, f.label).catch(e => {
      log(`⚠️ Summary Board error on ${f.label}: ${e.message}`);
      return { p3: null, p4: null, is_summary: false };
    })
  );

  const [audioResult, ...summaryResults] = await Promise.all([audioPromise, ...summaryPromises]);

  // Step 4: Cross-Validate (Audio is authority)
  const validated = crossValidate(audioResult, summaryResults);

  // Gold frame: Prioritize AI-confirmed summary board. 
  // Fallback: Always use the last frame (54s) if no confirmation, as it contains the board 99.9% of the time.
  const confirmedIndex = summaryResults.findIndex(r => r.is_summary === true);
  const goldFrame = confirmedIndex !== -1 
    ? summaryFrames[confirmedIndex].path 
    : (summaryFrames.length > 0 ? summaryFrames[summaryFrames.length - 1].path : null);

  cleanupOldAnalyses();

  return { ...validated, source: "bliss_ironclad_v4", folder: folderPath, goldFrame };
}

module.exports = { analyzeVideo, cleanupAnalysis: cleanupOldAnalyses };
