/**
 * WhatsApp Setup — escanea QR para vincular el número admin al VPS.
 *
 * Uso (desde el VPS):
 *   node tools/whatsapp-setup.js
 *
 * Abre WhatsApp en el teléfono admin → Settings → Linked Devices →
 * Link a Device → escanea el QR que aparece en la terminal.
 *
 * La sesión se guarda en auth-state/baileys/ y persiste indefinidamente.
 */

const { getSocket } = require("../src/whatsapp");

(async () => {
  console.log("🔐 Iniciando auth de WhatsApp...");
  console.log("📂 Sesión se guardará en: auth-state/baileys/");
  console.log("");

  try {
    await getSocket({ printQR: true });
    console.log("");
    console.log("✅ Vinculación completa. Ya puedes cerrar este proceso (Ctrl+C).");
    console.log("");
    console.log("Siguiente paso: corre `node tools/whatsapp-find-group.js`");
    console.log("para obtener el WHATSAPP_GROUP_ID del grupo donde quieres publicar.");

    // Mantener el proceso vivo brevemente para que se guarden creds
    await new Promise(r => setTimeout(r, 3000));
    process.exit(0);
  } catch (e) {
    console.error("❌ Falló:", e.message);
    process.exit(1);
  }
})();
