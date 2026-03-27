const { fetchLatestVideosViaScrape } = require('./src/monitor');
const fs = require('fs');

async function test() {
    console.log("🔍 Fetching latest videos...");
    const videos = await fetchLatestVideosViaScrape();
    const midday = videos.find(v => v.title.toLowerCase().includes('midday') && v.title.includes('20260326'));
    
    if (midday) {
        console.log(`🎯 FOUND TODAY'S MIDDAY: ${midday.title} (${midday.id})`);
    } else {
        const latestMidday = videos.find(v => v.title.toLowerCase().includes('midday'));
        console.log(`⚠️  Today's midday not found yet. Latest midday found: ${latestMidday ? latestMidday.title : 'None'}`);
    }
}

test();
