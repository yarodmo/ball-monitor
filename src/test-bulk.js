require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const https = require("https");
const { analyzeVideo } = require("./video-analyzer");

function log(msg) {
  console.log(`[${new Date().toISOString()}] [BULK-TEST] ${msg}`);
}

async function main() {
  log("🛡️ STARTING BULK FORENSIC TEST...");

  // 1. Get latest videos from RSS
  const rssXml = await new Promise((resolve, reject) => {
    https.get("https://www.youtube.com/feeds/videos.xml?channel_id=UCPm7mcdzUK9PjQtdGX4_Niw", res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
    }).on("error", reject);
  });

  const entries = [...rssXml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  if (!entries.length) throw new Error("No videos found");

  const pickVideos = [];
  for (const match of entries) {
    const entry = match[1];
    const title = (entry.match(/<title>(.*?)<\/title>/) || [])[1] || "";
    if (title.toLowerCase().includes("pick mid") || title.toLowerCase().includes("pick eve")) {
      const videoTitle = title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const videoId = (entry.match(/yt:videoId>(.*?)<\/yt:videoId/) || [])[1];
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      pickVideos.push({ videoId, videoTitle, videoUrl });
    }
  }

  log(`🎬 Found ${pickVideos.length} recent Pick videos.`);
  
  const testLimit = Math.min(pickVideos.length, 5); // Test the last 5
  log(`🚀 Testing the last ${testLimit} videos...`);

  for (let i = 0; i < testLimit; i++) {
    const v = pickVideos[i];
    log(`-------------------------------------------------`);
    log(`🎯 [${i+1}/${testLimit}] Testing: "${v.videoTitle}" (${v.videoId})`);
    try {
      const result = await analyzeVideo(v.videoUrl, v.videoId, v.videoTitle);
      log(`✅ AI Result for ${v.videoTitle}: P3=${result.p3 || "?"} P4=${result.p4 || "?"} [Conf: ${result.confidence || "Unknown"}]`);
    } catch (err) {
      log(`❌ Error testing ${v.videoTitle}: ${err.message}`);
    }
  }

  log(`-------------------------------------------------`);
  log("🏆 BULK TEST COMPLETE.");
}

main().catch(console.error);
