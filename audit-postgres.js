const { Client } = require('pg');

const connectionString = "postgresql://ballbot:GkSreValvYLif76JpZK96tMFjBLsf3fN@dpg-d70k07ruibrs73cj5300-a.oregon-postgres.render.com/ballbot_db?ssl=true";

async function audit() {
  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("✅ Postgres Auditing Connection: LIVE");

    const res = await client.query('SELECT * FROM "draws" ORDER BY "date" DESC, "id" DESC LIMIT 5');
    console.log("📋 Current Recent Data (Raw Audit):");
    console.table(res.rows);

    await client.end();
  } catch (err) {
    console.error("❌ Audit Connection Failure:", err.message);
    process.exit(1);
  }
}

audit();
