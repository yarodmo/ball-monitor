/**
 * Test: VideoAnalyzer — Real Video Analysis
 *
 * Runs the full AI video analysis pipeline against a known FL Lottery video
 * to verify that Gemini correctly extracts Pick 3 and Pick 4 numbers.
 *
 * Usage:
 *   GEMINI_API_KEY=your_key node src/test-video-analyzer.js
 *
 * Expected result for video Q-Th9fDpgHs (Pick Evening 20260323):
 *   P3 = 232
 *   P4 = 8271
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { analyzeVideo, cleanupAnalysis } = require("./video-analyzer");

// ─── Test Config ────────────────────────────────────────────────────────────
const TEST_VIDEO_ID = "NgL9KYOeTDE";
const TEST_VIDEO_URL = `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`;

// Known correct values (verified manually from the video)
const EXPECTED_P3 = "883";
const EXPECTED_P4 = "2721";

async function runTest() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("🧪 TEST: VideoAnalyzer — Full Pipeline");
  console.log(`📺 Video: ${TEST_VIDEO_URL}`);
  console.log(`📋 Expected: P3=${EXPECTED_P3} P4=${EXPECTED_P4}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!process.env.GEMINI_API_KEY) {
    console.error("❌ ERROR: GEMINI_API_KEY not set.");
    console.error("   Run: GEMINI_API_KEY=your_key node src/test-video-analyzer.js");
    process.exit(1);
  }

  const start = Date.now();

  try {
    const result = await analyzeVideo(TEST_VIDEO_URL, TEST_VIDEO_ID);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("📊 RESULTADOS DEL TEST");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`⏱️  Tiempo total: ${elapsed}s`);
    console.log(`🎯 Pick 3: ${result.p3 || "N/A"} (esperado: ${EXPECTED_P3}) → ${result.p3 === EXPECTED_P3 ? "✅ MATCH" : "❌ MISMATCH"}`);
    console.log(`🎯 Pick 4: ${result.p4 || "N/A"} (esperado: ${EXPECTED_P4}) → ${result.p4 === EXPECTED_P4 ? "✅ MATCH" : "❌ MISMATCH"}`);
    console.log(`🔒 Confianza: ${result.confidence.toUpperCase()}`);
    console.log(`📡 Fuente: ${result.source}`);
    console.log("───────────────────────────────────────────────────────────");

    if (result.details) {
      console.log("\n📋 Detalles de Validación Cruzada:");
      console.log(`   👁️  Vision: P3=${result.details.vision?.p3 || "?"} P4=${result.details.vision?.p4 || "?"}`);
      console.log(`   👂 Audio:  P3=${result.details.audio?.p3 || "?"} P4=${result.details.audio?.p4 || "?"}`);
      console.log(`   🔗 P3 Match: ${result.details.p3Match ? "✅" : "❌"} | P4 Match: ${result.details.p4Match ? "✅" : "❌"}`);

      if (result.details.vision?.p3Votes) {
        console.log(`   📊 P3 Votes: ${JSON.stringify(result.details.vision.p3Votes)}`);
      }
      if (result.details.vision?.p4Votes) {
        console.log(`   📊 P4 Votes: ${JSON.stringify(result.details.vision.p4Votes)}`);
      }
    }

    const allCorrect = result.p3 === EXPECTED_P3 && result.p4 === EXPECTED_P4;
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log(allCorrect
      ? "🏆 TEST PASSED — AI extraction matches known values"
      : "⚠️  TEST NEEDS REVIEW — AI extraction differed from expected values"
    );
    console.log("═══════════════════════════════════════════════════════════");

    // Ask user before cleanup
    console.log("\n💡 Analysis files preserved in captures/analysis/ for manual inspection.");
    console.log("   Run: cleanupAnalysis('" + TEST_VIDEO_ID + "') to remove them.");

  } catch (e) {
    console.error("\n❌ TEST FAILED WITH ERROR:");
    console.error(e);
    process.exit(1);
  }
}

runTest();
