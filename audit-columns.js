const { Client } = require('pg');

const connectionString = "postgresql://ballbot:GkSreValvYLif76JpZK96tMFjBLsf3fN@dpg-d70k07ruibrs73cj5300-a.oregon-postgres.render.com/ballbot_db";

async function audit() {
  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const res = await client.query('SELECT * FROM "draws" LIMIT 1');
    console.log("Column Names:", Object.keys(res.rows[0] || {}).join(", "));
    
    // Get last 5
    const res2 = await client.query('SELECT * FROM "draws" LIMIT 5');
    console.table(res2.rows);

    await client.end();
  } catch (err) {
    console.error("Column mapping failed:", err.message);
  }
}

audit();
