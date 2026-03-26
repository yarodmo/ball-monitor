const { Client } = require('pg');

const connectionString = "postgresql://ballbot:GkSreValvYLif76JpZK96tMFjBLsf3fN@dpg-d70k07ruibrs73cj5300-a.oregon-postgres.render.com/ballbot_db";

async function inject() {
  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("⚡ INYECCIÓN FORENSE INICIADA...");

    const sql = 'INSERT INTO "draws" (date, game, period, numbers) VALUES ($1, $2, $3, $4)';
    
    // Pick 3
    await client.query(sql, ['03/25/26', 'p3', 'e', '7,7,4']);
    console.log("✅ P3 (7,7,4) INYECTADO CORRECTAMENTE");

    // Pick 4
    await client.query(sql, ['03/25/26', 'p4', 'e', '6,2,7,6']);
    console.log("✅ P4 (6,2,7,6) INYECTADO CORRECTAMENTE");

    console.log("🏁 FLUJO COMPLETO EXITOSO. DATOS EN VIVO.");
    await client.end();
  } catch (err) {
    console.error("❌ Error de Inyección:", err.message);
    process.exit(1);
  }
}

inject();
