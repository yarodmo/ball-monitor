/**
 * WhatsApp Find Group — lista los grupos donde el número admin es miembro
 * y muestra el Group ID (formato: 1234567890-1234567890@g.us).
 *
 * Uso (después de whatsapp-setup.js):
 *   node tools/whatsapp-find-group.js
 *
 * Copia el ID del grupo correcto al .env como WHATSAPP_GROUP_ID.
 */

const { getSocket } = require("../src/whatsapp");

(async () => {
  console.log("🔍 Conectando y listando grupos...");

  try {
    const sock = await getSocket();
    // Esperar un breve momento para que sincronice metadata
    await new Promise(r => setTimeout(r, 5000));

    const groups = await sock.groupFetchAllParticipating();
    const entries = Object.values(groups);

    if (entries.length === 0) {
      console.log("⚠️  No estás en ningún grupo todavía. Crea el grupo desde el teléfono primero.");
      process.exit(0);
    }

    console.log("");
    console.log(`📋 ${entries.length} grupo(s) encontrados:`);
    console.log("");
    for (const g of entries) {
      console.log(`  📌 ${g.subject}`);
      console.log(`     ID: ${g.id}`);
      console.log(`     Miembros: ${g.participants?.length || "?"}`);
      console.log("");
    }

    console.log("Copia el ID del grupo destino al .env:");
    console.log("  WHATSAPP_GROUP_ID=xxxxxxxxxx-xxxxxxxxxx@g.us");

    process.exit(0);
  } catch (e) {
    console.error("❌ Falló:", e.message);
    process.exit(1);
  }
})();
