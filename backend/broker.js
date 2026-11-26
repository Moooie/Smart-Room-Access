// ==========================================================
// Standalone MQTT Broker (Aedes) on Port 1883
// Smart Scheduled Room Access System
// ==========================================================

const net = require('net');
const { Aedes } = require('aedes');

async function startBroker() {
  const aedes = new Aedes({
    authenticate: (client, username, password, callback) => {
      // Fleksibel: terima anonymous untuk testing, atau cek user backend & esp32
      const u = username ? username.toString() : '';
      const p = password ? password.toString() : '';

      if (!u) return callback(null, true);
      if (u === 'backend' && p === 'iotbackend') return callback(null, true);
      if (u === 'esp32' && p === 'iotcemas') return callback(null, true);

      return callback(null, true);
    }
  });

  await aedes.listen();

  const server = net.createServer(aedes.handle);
  const PORT = process.env.MQTT_PORT || 1884;

  server.listen(PORT, '0.0.0.0', () => {
    console.log('==========================================================');
    console.log(`📡 MQTT Broker (Aedes) Berjalan di Port: ${PORT}`);
    console.log('Mendukung koneksi dari ESP32 dan Backend!');
    console.log('==========================================================');
  });

  aedes.on('client', (client) => {
    console.log(`[MQTT Broker] Client Terhubung: ${client ? client.id : 'unknown'}`);
  });

  aedes.on('clientDisconnect', (client) => {
    console.log(`[MQTT Broker] Client Terputus: ${client ? client.id : 'unknown'}`);
  });

  aedes.on('publish', (packet) => {
    if (packet.topic && packet.topic.startsWith('room/')) {
      console.log(`[MQTT Broker] Topik: ${packet.topic} | Payload: ${packet.payload.toString()}`);
    }
  });
}

startBroker().catch(err => {
  console.error('[MQTT Broker Error]:', err);
});
