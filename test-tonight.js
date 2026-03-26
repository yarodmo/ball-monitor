const { analyzeVideo } = require("./src/video-analyzer");
require("dotenv").config({ path: "./.env" });

const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=0AmamoIFbQo";
const TEST_VIDEO_ID = "0AmamoIFbQo";
const TEST_VIDEO_TITLE = "Pick Evening 20260325";

async function run() {
  console.log("🚀 Testing Bliss Forensic Pipeline (TONIGHT DRAW)");
  try {
    const result = await analyzeVideo(TEST_VIDEO_URL, TEST_VIDEO_ID, TEST_VIDEO_TITLE);
    console.log("FINAL RESULT:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("FAILED:", e.message);
  }
}

run();
