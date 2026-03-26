const https = require("https");
const { analyzeVideo } = require("./src/video-analyzer");
require("dotenv").config({ path: "./.env" });

const CHANNEL_ID = "UCPm7mcdzUK9PjQtdGX4_Niw";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

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
    if (id) {
      videos.push({
        id,
        title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
        url: `https://www.youtube.com/watch?v=${id}`
      });
    }
  }
  return videos;
}

async function run() {
  console.log("🚀 Buscando el video más reciente en el canal de FL Lottery...");
  const xml = await fetchRSS(RSS_URL);
  const videos = parseRSSVideos(xml);
  
  const todayEveningTitle = "Pick Evening 20260325";
  const video = videos.find(v => v.title.includes(todayEveningTitle) || (/Pick.*Evening/i.test(v.title)));
  
  if (!video) {
    console.log("❌ No se encontró un video de Evening reciente en el RSS.");
    console.log("Últimos videos encontrados:");
    videos.slice(0, 3).forEach(v => console.log(`   - ${v.title}`));
    return;
  }
  
  console.log(`🎯 Video Encontrado: "${video.title}" [ID: ${video.id}]`);
  
  try {
    const result = await analyzeVideo(video.url, video.id, video.title);
    console.log("\n✅ RESULTADO OBTENIDO 101% CONFIRMADO:\n", JSON.stringify(result, null, 2));
  } catch(e) {
    console.error("❌ FAILED:", e.message);
  }
}

run();
