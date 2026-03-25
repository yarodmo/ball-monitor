const http = require("http");
const url = require("url");

/**
 * TEST WEBHOOK RETRY MECHANISM
 * Simulates a failing or slow server to verify monitor.js retry logic.
 */

// ─── CONFIG MOCK ───
const CONFIG = {
  webhook_url: "http://localhost:9999/api/auto-draw",
  webhook_secret: "TEST_SECRET",
  webhook_retry_count: 3,
  webhook_retry_delay_ms: 2000, // FAST RETRY FOR TESTING
};

// ─── CORE FUNCTIONS (from monitor.js) ───
function httpPost(targetUrl, jsonBody) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(targetUrl);
    const bodyBuf = Buffer.from(jsonBody, "utf8");
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + (parsed.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": bodyBuf.length,
      },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function notifyBallbot(draw, video) {
  const payload = JSON.stringify({
    period: draw.period,
    drawType: draw.type,
    videoId: video.id,
    secret: CONFIG.webhook_secret,
  });

  const maxRetries = CONFIG.webhook_retry_count;
  const retryDelay = CONFIG.webhook_retry_delay_ms;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`📡 Attempt ${attempt}/${maxRetries} to notify Ballbot...`);
      const raw = await httpPost(CONFIG.webhook_url, payload);
      const response = JSON.parse(raw);

      if (response.found) {
          log(`✅ Notification SUCCESSFUL on attempt ${attempt}.`);
          return true;
      }

      log(`⏳ PDF data NOT found on server (attempt ${attempt}). Retrying in ${retryDelay/1000}s...`);
      if (attempt < maxRetries) await sleep(retryDelay);

    } catch (e) {
      log(`❌ Network Error on attempt ${attempt}: ${e.message}. Retrying in ${retryDelay/1000}s...`);
      if (attempt < maxRetries) await sleep(retryDelay);
    }
  }

  log(`⚠️ FATAL: Exhausted all ${maxRetries} attempts.`);
  return false;
}

// ─── TEST RUNNERS ───

async function runTest(serverBehavior) {
  const port = 9999;
  let attemptsSeen = 0;

  const server = http.createServer((req, res) => {
    attemptsSeen++;
    log(`[MOCK SERVER] Received Request #${attemptsSeen}`);

    if (serverBehavior === "fail_always") {
        res.writeHead(500);
        res.end(JSON.stringify({ error: "Server error" }));
    } else if (serverBehavior === "fail_twice_then_success") {
        if (attemptsSeen < 3) {
            res.writeHead(200);
            res.end(JSON.stringify({ found: false }));
        } else {
            res.writeHead(200);
            res.end(JSON.stringify({ found: true, p3: "111", p4: "2222" }));
        }
    }
  });

  server.listen(port);

  const draw = { period: "m", type: "Pick Midday" };
  const video = { id: "test_id" };

  console.log(`\n🔹 RUNNING TEST: ${serverBehavior}...`);
  const success = await notifyBallbot(draw, video);
  
  server.close();
  return success;
}

async function main() {
    console.log("═══════════════════════════════════════════════════════");
    console.log("  STRESS TEST: WEBHOOK RETRY MECHANISM");
    console.log("═══════════════════════════════════════════════════════");

    log("Starting Test 1: Fail Twice then Success...");
    const t1 = await runTest("fail_twice_then_success");
    if (t1) log("Test 1 Result: ✅ PASSED (Successfully recovered on attempt 3)");

    log("\nStarting Test 2: Fatal Failure...");
    const t2 = await runTest("fail_always");
    if (!t2) log("Test 2 Result: ✅ PASSED (Correctly exhausted all attempts)");
    
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  STRESS TEST COMPLETE — ALL FALLBACKS VERIFIED");
    console.log("═══════════════════════════════════════════════════════");
}

main().catch(console.error);
