// ==========================================================
// Smart Scheduled Room Access System
// Backend (Layer 3: API/Gateway & Layer 4: Application Server)
// Framework: Express, WebSocket (ws), MQTT, MySQL2, JWT, Bcrypt
// ==========================================================

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const mqtt = require('mqtt');
const { WebSocketServer, WebSocket } = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

// Muat variabel lingkungan (.env)
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || 'KELOMPOKIOTEMAS';
const JWT_SECRET = process.env.JWT_SECRET || 'smart_room_super_secret_jwt_key_2026_kelompok_iot_emas';
const DOOR_UNLOCK_DURATION = parseInt(process.env.DOOR_UNLOCK_DURATION || '4000', 10);

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'smart_room',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  dateStrings: true, // Pastikan tipe DATE dan TIME dikembalikan sebagai string
  timezone: '+07:00',
  ssl: (process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST !== 'localhost' && process.env.DB_HOST !== '127.0.0.1'))
    ? { rejectUnauthorized: false }
    : undefined,
};

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const MQTT_USER = process.env.MQTT_USER || 'backend';
const MQTT_PASS = process.env.MQTT_PASS || 'iotbackend';

// Inisialisasi Database Pool
const db = mysql.createPool(DB_CONFIG);

// Pastikan setiap koneksi MySQL menggunakan zona waktu WIB (+07:00)
db.on('connection', (conn) => {
  conn.query("SET time_zone = '+07:00'");
});

// Tes koneksi database di awal
(async () => {
  try {
    const conn = await db.getConnection();
    console.log(`[DB] Berhasil terhubung ke database MySQL '${DB_CONFIG.database}' di ${DB_CONFIG.host}:${DB_CONFIG.port}`);
    conn.release();
  } catch (err) {
    console.error('[DB] Gagal terhubung ke MySQL:', err.message);
    console.error('[DB] Pastikan MySQL di XAMPP sudah berjalan dan skema smart_room sudah diimport.');
  }
})();

// Inisialisasi Express & HTTP Server
const app = express();
const server = http.createServer(app);

// Middleware dasar
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// ==========================================================
// REAL-TIME PUSH: WEBSOCKET SERVER
// ==========================================================
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  // Kirim salam pembuka dan status awal
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    message: 'Terhubung ke Real-Time WebSocket Server Smart Room',
    timestamp: new Date().toISOString()
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
    wsClients.delete(ws);
  });
});

/**
 * Broadcast event real-time ke semua dashboard browser yang terhubung
 */
function broadcast(type, payload) {
  const message = JSON.stringify({
    type,
    data: payload,
    timestamp: new Date().toISOString()
  });

  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Timer penutup pintu otomatis untuk tiap ruangan (debounce/clear timeout lama)
const doorRelockTimers = {};

function scheduleDoorRelock(kodeRuangan, durationMs = DOOR_UNLOCK_DURATION) {
  const kode = kodeRuangan.toUpperCase();
  if (doorRelockTimers[kode]) {
    clearTimeout(doorRelockTimers[kode]);
  }

  doorRelockTimers[kode] = setTimeout(async () => {
    try {
      await db.query("UPDATE rooms SET status_pintu = 'locked' WHERE kode_ruangan = ?", [kode]);
      console.log(`[DOOR] Ruang ${kode} otomatis terkunci kembali (${durationMs}ms)`);
      broadcast('DOOR_STATUS', { room: kode, status: 'locked' });
      broadcastStats();
    } catch (err) {
      console.error(`[DOOR] Gagal mengunci kembali pintu ${kode}:`, err.message);
    } finally {
      delete doorRelockTimers[kode];
    }
  }, durationMs);
}

// ==========================================================
// MQTT CLIENT (LAYER 3: ESP32 GATEWAY)
// ==========================================================
const mqttClient = mqtt.connect(MQTT_BROKER, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: `backend_${Math.random().toString(16).substring(2, 8)}`,
  reconnectPeriod: 3000,
  connectTimeout: 5000,
});

mqttClient.on('connect', () => {
  console.log(`[MQTT] Terhubung ke broker MQTT di ${MQTT_BROKER}`);
  mqttClient.subscribe(['room/+/status', 'room/+/access-log', 'room/+/door-state'], (err) => {
    if (err) console.error('[MQTT] Gagal subscribe topik:', err);
    else console.log('[MQTT] Berhasil subscribe ke topik room/+/status, room/+/access-log, dan room/+/door-state');
  });
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Mencoba menghubungkan kembali ke broker MQTT...');
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Koneksi error:', err.message);
});

mqttClient.on('message', async (topic, payload) => {
  const parts = topic.split('/');
  if (parts.length < 3) return;
  const roomLower = parts[1];
  const kind = parts[2];
  const kode = roomLower.toUpperCase();
  const rawMsg = payload.toString();

  try {
    if (kind === 'status') {
      const deviceStatus = rawMsg.trim() === 'online' ? 'online' : 'offline';
      await db.query('UPDATE rooms SET status_device = ? WHERE kode_ruangan = ?', [deviceStatus, kode]);
      console.log(`[MQTT] Status perangkat ${kode}: ${deviceStatus}`);

      broadcast('DEVICE_STATUS', { room: kode, status: deviceStatus });
      broadcastStats();
    } else if (kind === 'door-state') {
      const doorState = rawMsg.trim() === 'unlocked' ? 'unlocked' : 'locked';
      if (doorState === 'locked' && doorRelockTimers[kode]) {
        clearTimeout(doorRelockTimers[kode]);
        delete doorRelockTimers[kode];
      }
      await db.query('UPDATE rooms SET status_pintu = ? WHERE kode_ruangan = ?', [doorState, kode]);
      console.log(`[MQTT] Status pintu fisik ${kode}: ${doorState}`);
      broadcast('DOOR_STATUS', { room: kode, status: doorState, duration: 0 });
      broadcastStats();
    } else if (kind === 'access-log') {
      let d;
      try {
        d = JSON.parse(rawMsg);
      } catch (pe) {
        console.error('[MQTT] Format JSON access-log tidak valid:', rawMsg);
        return;
      }

      // Abaikan echo remote access-log dari ESP32 karena POST /unlock sudah menangani status & log
      if (d.method === 'remote' || d.uid === 'REMOTE') {
        return;
      }

      const [[room]] = await db.query('SELECT id_room, nama_ruangan FROM rooms WHERE kode_ruangan = ?', [kode]);
      if (!room) {
        console.warn(`[MQTT] Ruangan ${kode} tidak ditemukan dalam database`);
        return;
      }

      // Cari user berdasarkan RFID UID
      const [[user]] = await db.query(
        'SELECT id_user, nama_lengkap, nim_nip, role FROM users WHERE rfid_uid = ?',
        [d.uid]
      );

      // Cari jadwal aktif jika ada (termasuk jam_selesai untuk durasi buka pintu)
      let activeScheduleId = null;
      let remainingMs = DOOR_UNLOCK_DURATION;
      if (user) {
        const [[sched]] = await db.query(
          `SELECT id_schedule, TIME_TO_SEC(TIMEDIFF(jam_selesai, CURTIME())) AS remaining_sec
             FROM schedules 
            WHERE id_user = ? AND id_room = ? AND status_jadwal = 'approved'
              AND tanggal_akses = CURDATE()
              AND CURTIME() BETWEEN jam_mulai AND jam_selesai
            LIMIT 1`,
          [user.id_user, room.id_room]
        );
        if (sched) {
          activeScheduleId = sched.id_schedule;
          if (sched.remaining_sec && sched.remaining_sec > 0) {
            remainingMs = sched.remaining_sec * 1000;
          }
        }
      }

      const ts = d.ts && d.ts.length >= 19 ? d.ts.slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
      const statusAkses = d.status === 'granted' ? 'granted' : 'denied';
      const metodeAkses = d.method === 'remote' ? 'remote' : 'rfid';
      const keterangan = d.reason || (statusAkses === 'granted' ? 'OK' : 'DENIED');

      const [resInsert] = await db.query(
        `INSERT INTO access_logs (id_room, id_user, id_schedule, rfid_uid_tap, waktu_tap, metode_akses, status_akses, keterangan)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [room.id_room, user ? user.id_user : null, activeScheduleId, d.uid, ts, metodeAkses, statusAkses, keterangan]
      );

      console.log(`[MQTT] Log Akses ${kode} | UID: ${d.uid} | Status: ${statusAkses} (${keterangan})`);

      // Jika akses RFID diterima, pintu tetap terbuka sampai jadwal selesai
      if (statusAkses === 'granted') {
        await db.query("UPDATE rooms SET status_pintu = 'unlocked' WHERE id_room = ?", [room.id_room]);
        broadcast('DOOR_STATUS', { room: kode, status: 'unlocked', duration: remainingMs });
        scheduleDoorRelock(kode, remainingMs);
      }

      // Broadcast log baru ke UI dashboard
      broadcast('ACCESS_LOG', {
        id_log: resInsert.insertId,
        kode_ruangan: kode,
        nama_ruangan: room.nama_ruangan,
        id_user: user ? user.id_user : null,
        nama_lengkap: user ? user.nama_lengkap : (d.uid === 'REMOTE' ? 'Remote Operator' : 'Pengguna Belum Terdaftar'),
        nim_nip: user ? user.nim_nip : '-',
        role: user ? user.role : '-',
        rfid_uid_tap: d.uid,
        waktu_tap: ts,
        metode_akses: metodeAkses,
        status_akses: statusAkses,
        keterangan: keterangan,
      });

      broadcastStats();
    }
  } catch (err) {
    console.error('[MQTT] Handler Error:', err.message);
  }
});

// Helper broadcast ringkasan statistik
async function broadcastStats() {
  try {
    const [[{ totalAksesHariIni }]] = await db.query(
      'SELECT COUNT(*) as totalAksesHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE()'
    );
    const [[{ aksesGrantedHariIni }]] = await db.query(
      "SELECT COUNT(*) as aksesGrantedHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE() AND status_akses = 'granted'"
    );
    const [[{ aksesDeniedHariIni }]] = await db.query(
      "SELECT COUNT(*) as aksesDeniedHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE() AND status_akses = 'denied'"
    );
    const [[{ jadwalPending }]] = await db.query(
      "SELECT COUNT(*) as jadwalPending FROM schedules WHERE status_jadwal = 'pending'"
    );
    const [[{ perangkatOnline }]] = await db.query(
      "SELECT COUNT(*) as perangkatOnline FROM rooms WHERE status_device = 'online'"
    );
    const [[{ totalRuangan }]] = await db.query(
      'SELECT COUNT(*) as totalRuangan FROM rooms'
    );

    broadcast('STATS_UPDATE', {
      totalAksesHariIni,
      aksesGrantedHariIni,
      aksesDeniedHariIni,
      jadwalPending,
      perangkatOnline,
      totalRuangan,
    });
  } catch (err) {
    // Abaikan jika database sesaat sibuk
  }
}

// ==========================================================
// AUTHENTICATION & RBAC MIDDLEWARE
// ==========================================================
function generateToken(user) {
  return jwt.sign(
    {
      id_user: user.id_user,
      nim_nip: user.nim_nip,
      nama_lengkap: user.nama_lengkap,
      email: user.email,
      role: user.role,
      rfid_uid: user.rfid_uid,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Token otentikasi tidak disediakan' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token', message: 'Sesi telah kedaluwarsa atau token tidak valid' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Akses ditolak. Fitur ini hanya untuk Administrator' });
  }
  next();
}

// ==========================================================
// REST API: AUTHENTICATION
// ==========================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'NIM/NIP atau Email dan Password wajib diisi' });
  }

  try {
    const [users] = await db.query(
      'SELECT * FROM users WHERE nim_nip = ? OR email = ? LIMIT 1',
      [identifier.trim(), identifier.trim()]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'NIM/Email atau Password salah' });
    }

    const user = users[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'no_password_set', message: 'Akun ini belum memiliki password. Hubungi Admin' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'invalid_credentials', message: 'NIM/Email atau Password salah' });
    }

    const token = generateToken(user);
    res.json({
      message: 'Login berhasil',
      token,
      user: {
        id_user: user.id_user,
        nim_nip: user.nim_nip,
        nama_lengkap: user.nama_lengkap,
        email: user.email,
        role: user.role,
        rfid_uid: user.rfid_uid,
      }
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'server_error', message: 'Terjadi kesalahan saat memproses login' });
  }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { nim_nip, nama_lengkap, email, password, rfid_uid, role } = req.body;
  if (!nim_nip || !nama_lengkap || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'NIM/NIP, Nama Lengkap, dan Password wajib diisi' });
  }

  const assignedRole = (role && ['admin', 'dosen', 'mahasiswa'].includes(role.toLowerCase()))
    ? role.toLowerCase()
    : 'mahasiswa';

  const cleanUid = rfid_uid && rfid_uid.trim().length > 0 ? rfid_uid.trim().toUpperCase() : null;

  try {
    // Periksa keunikan NIM/NIP, email, dan rfid_uid
    const [existing] = await db.query(
      'SELECT nim_nip, email, rfid_uid FROM users WHERE nim_nip = ? OR (email = ? AND email IS NOT NULL) OR (rfid_uid = ? AND rfid_uid IS NOT NULL)',
      [nim_nip.trim(), email ? email.trim() : null, cleanUid]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        error: 'duplicate_entry',
        message: 'NIM/NIP, Email, atau UID Kartu RFID sudah terdaftar'
      });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const [result] = await db.query(
      `INSERT INTO users (nim_nip, nama_lengkap, email, password_hash, rfid_uid, role)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [nim_nip.trim(), nama_lengkap.trim(), email ? email.trim() : null, passwordHash, cleanUid, assignedRole]
    );

    const newUser = {
      id_user: result.insertId,
      nim_nip: nim_nip.trim(),
      nama_lengkap: nama_lengkap.trim(),
      email: email ? email.trim() : null,
      role: assignedRole,
      rfid_uid: cleanUid,
    };

    const token = generateToken(newUser);
    res.status(201).json({
      message: 'Pendaftaran akun berhasil',
      token,
      user: newUser
    });
  } catch (err) {
    console.error('[AUTH] Register error:', err);
    res.status(500).json({ error: 'server_error', message: 'Gagal mendaftarkan pengguna baru' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', verifyToken, async (req, res) => {
  try {
    const [[user]] = await db.query(
      'SELECT id_user, nim_nip, nama_lengkap, email, role, rfid_uid FROM users WHERE id_user = ?',
      [req.user.id_user]
    );
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'db_error' });
  }
});

// ==========================================================
// REST API: ESP32 SCHEDULES (LAYER 3 - EXISTING FIRMWARE COMPATIBLE)
// ==========================================================
// Dipergunakan oleh ESP32 melalui HTTP GET /api/schedules?room=<ROOM_ID>
// dengan header x-api-key: KELOMPOKIOTEMAS
app.get('/api/schedules', async (req, res) => {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized', message: 'API Key tidak valid' });
  }

  let room = String(req.query.room || '').toUpperCase();
  try {
    let sql = `
      SELECT u.rfid_uid, r.kode_ruangan, s.tanggal_akses, s.jam_mulai, s.jam_selesai
        FROM schedules s
        JOIN users u ON u.id_user = s.id_user
        JOIN rooms r ON r.id_room = s.id_room
       WHERE s.status_jadwal = 'approved'
         AND s.tanggal_akses BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 DAY)
         AND u.rfid_uid IS NOT NULL
    `;
    const params = [];
    if (room && room !== 'ALL') {
      sql += ' AND r.kode_ruangan = ?';
      params.push(room);
    }

    const [rows] = await db.query(sql, params);

    // Format output persis sesuai spesifikasi Bab 3 & firmware ESP32
    res.json(rows.map(r => ({
      uid: r.rfid_uid,
      roomId: r.kode_ruangan,
      date: r.tanggal_akses,
      start: r.jam_mulai.slice(0, 5),
      end: r.jam_selesai.slice(0, 5),
      approved: true,
    })));
  } catch (e) {
    console.error('[API] Error schedules for ESP32:', e);
    res.status(500).json({ error: 'db_error' });
  }
});

// ==========================================================
// REST API: ROOMS & REMOTE UNLOCK
// ==========================================================

// GET /api/rooms - Mengambil daftar seluruh ruangan, status pintu, status online, dan jadwal aktif
app.get('/api/rooms', async (req, res) => {
  try {
    const [rooms] = await db.query(
      'SELECT id_room, kode_ruangan, nama_ruangan, device_id, status_pintu, status_device, jam_buka, jam_tutup FROM rooms ORDER BY id_room ASC'
    );

    // Ambil jadwal aktif hari ini di jam saat ini untuk masing-masing ruangan
    const enrichedRooms = await Promise.all(rooms.map(async (r) => {
      const [[activeSchedule]] = await db.query(
        `SELECT s.id_schedule, s.jam_mulai, s.jam_selesai, s.keperluan,
                u.id_user, u.nama_lengkap, u.nim_nip, u.role
           FROM schedules s
           JOIN users u ON u.id_user = s.id_user
          WHERE s.id_room = ?
            AND s.status_jadwal = 'approved'
            AND s.tanggal_akses = CURDATE()
            AND CURTIME() BETWEEN s.jam_mulai AND s.jam_selesai
          LIMIT 1`,
        [r.id_room]
      );

      return {
        ...r,
        jam_buka: r.jam_buka ? r.jam_buka.slice(0, 5) : '07:00',
        jam_tutup: r.jam_tutup ? r.jam_tutup.slice(0, 5) : '21:00',
        active_schedule: activeSchedule ? {
          id_schedule: activeSchedule.id_schedule,
          jam_mulai: activeSchedule.jam_mulai.slice(0, 5),
          jam_selesai: activeSchedule.jam_selesai.slice(0, 5),
          keperluan: activeSchedule.keperluan,
          user: {
            id_user: activeSchedule.id_user,
            nama_lengkap: activeSchedule.nama_lengkap,
            nim_nip: activeSchedule.nim_nip,
            role: activeSchedule.role
          }
        } : null
      };
    }));

    res.json({ rooms: enrichedRooms });
  } catch (err) {
    console.error('[API] GET /api/rooms error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal memuat status ruangan' });
  }
});

// PUT /api/rooms/:id/hours - Admin mengubah jam operasional akses ruangan
app.put('/api/rooms/:id/hours', verifyToken, requireAdmin, async (req, res) => {
  const roomId = parseInt(req.params.id, 10);
  const { jam_buka, jam_tutup } = req.body;

  if (!jam_buka || !jam_tutup) {
    return res.status(400).json({ error: 'missing_fields', message: 'Jam buka dan jam tutup wajib diisi' });
  }

  if (jam_buka >= jam_tutup) {
    return res.status(400).json({ error: 'invalid_hours', message: 'Jam tutup harus lebih akhir dari jam buka' });
  }

  try {
    const [[room]] = await db.query('SELECT * FROM rooms WHERE id_room = ?', [roomId]);
    if (!room) {
      return res.status(404).json({ error: 'room_not_found', message: 'Ruangan tidak ditemukan' });
    }

    await db.query(
      'UPDATE rooms SET jam_buka = ?, jam_tutup = ? WHERE id_room = ?',
      [jam_buka, jam_tutup, roomId]
    );

    broadcast('ROOM_HOURS_UPDATED', {
      id_room: roomId,
      kode_ruangan: room.kode_ruangan,
      nama_ruangan: room.nama_ruangan,
      jam_buka: jam_buka.slice(0, 5),
      jam_tutup: jam_tutup.slice(0, 5)
    });

    res.json({
      message: `Jam operasional ${room.nama_ruangan} berhasil diubah menjadi ${jam_buka.slice(0, 5)} - ${jam_tutup.slice(0, 5)} WIB`,
      room: {
        id_room: roomId,
        kode_ruangan: room.kode_ruangan,
        jam_buka: jam_buka.slice(0, 5),
        jam_tutup: jam_tutup.slice(0, 5)
      }
    });
  } catch (err) {
    console.error('[API] PUT /api/rooms/:id/hours error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal memperbarui jam operasional ruangan' });
  }
});

// POST /api/rooms/:kode/unlock - Buka pintu dari Dashboard atau API
// Mendukung otentikasi via API Key (legacy) ATAU JWT Bearer Token
app.post('/api/rooms/:kode/unlock', async (req, res) => {
  const kode = req.params.kode.toLowerCase();
  const kodeUpper = kode.toUpperCase();

  const [[targetRoom]] = await db.query('SELECT id_room, kode_ruangan, nama_ruangan FROM rooms WHERE UPPER(kode_ruangan) = ?', [kodeUpper]);
  if (!targetRoom) {
    return res.status(404).json({ error: 'room_not_found', message: 'Ruangan tidak dikenali' });
  }

  let actorName = 'System/API';
  let actorUserId = null;
  let isAdminActor = false;
  let isAuthorized = false;

  // 1. Cek otentikasi via API Key
  if (req.get('x-api-key') === API_KEY) {
    isAuthorized = true;
    isAdminActor = true;
    actorName = 'API Key Operator';
  } else {
    // 2. Cek otentikasi via JWT Bearer Token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        actorUserId = decoded.id_user;
        actorName = decoded.nama_lengkap;

        if (decoded.role === 'admin') {
          // Admin memiliki hak akses penuh membuka pintu kapan saja
          isAuthorized = true;
          isAdminActor = true;
        } else {
          // Dosen / Mahasiswa HANYA boleh jika memiliki jadwal approved yang sedang aktif saat ini
          const [[roomData]] = await db.query('SELECT id_room FROM rooms WHERE kode_ruangan = ?', [kodeUpper]);
          if (roomData) {
            const [[activeSchedule]] = await db.query(
              `SELECT id_schedule FROM schedules
                WHERE id_user = ? AND id_room = ? AND status_jadwal = 'approved'
                  AND tanggal_akses = CURDATE()
                  AND CURTIME() BETWEEN jam_mulai AND jam_selesai
                LIMIT 1`,
              [decoded.id_user, roomData.id_room]
            );

            if (activeSchedule) {
              isAuthorized = true;
            } else {
              return res.status(403).json({
                error: 'no_active_schedule',
                message: 'Anda tidak memiliki jadwal akses yang disetujui dan aktif saat ini di ruangan ini.'
              });
            }
          }
        }
      } catch (tokenErr) {
        return res.status(401).json({ error: 'invalid_token', message: 'Sesi login tidak sah' });
      }
    }
  }

  if (!isAuthorized) {
    return res.status(401).json({ error: 'unauthorized', message: 'Otorisasi dibutuhkan untuk membuka pintu' });
  }

  // Periksa koneksi MQTT broker
  if (!mqttClient.connected) {
    return res.status(503).json({
      error: 'mqtt_down',
      message: 'Broker MQTT sedang tidak terhubung. Perangkat ESP32 tidak dapat menerima perintah unlock'
    });
  }

  // Publish perintah 'unlock' ke topik room/<kode>/command
  const topicCmd = `room/${kode}/command`;

  mqttClient.publish(topicCmd, 'unlock', { qos: 1 }, async (publishErr) => {
    if (publishErr) {
      console.error('[MQTT] Publish command failed:', publishErr);
      return res.status(502).json({ error: 'publish_failed', message: 'Gagal mengirim sinyal ke broker MQTT' });
    }

    try {
      // Perbarui status pintu di database
      await db.query("UPDATE rooms SET status_pintu = 'unlocked' WHERE kode_ruangan = ?", [kodeUpper]);
      console.log(`[REMOTE] Pintu ${kodeUpper} dibuka secara remote oleh ${actorName}`);

      // Broadcast update status pintu; jika bukan admin, jadwalkan relock otomatis
      broadcast('DOOR_STATUS', { room: kodeUpper, status: 'unlocked', duration: isAdminActor ? 0 : DOOR_UNLOCK_DURATION });
      if (!isAdminActor) {
        scheduleDoorRelock(kodeUpper);
      } else if (doorRelockTimers[kodeUpper]) {
        clearTimeout(doorRelockTimers[kodeUpper]);
        delete doorRelockTimers[kodeUpper];
      }

      // Simpan log remote unlock ke access_logs & broadcast ke live feed
      const [[room]] = await db.query('SELECT id_room, nama_ruangan FROM rooms WHERE kode_ruangan = ?', [kodeUpper]);
      if (room) {
        const [resInsert] = await db.query(
          `INSERT INTO access_logs (id_room, id_user, rfid_uid_tap, waktu_tap, metode_akses, status_akses, keterangan)
           VALUES (?, ?, 'REMOTE', NOW(), 'remote', 'granted', 'REMOTE_UNLOCK')`,
          [room.id_room, actorUserId]
        );
        broadcast('ACCESS_LOG', {
          id_log: resInsert.insertId,
          kode_ruangan: kodeUpper,
          nama_ruangan: room.nama_ruangan,
          id_user: actorUserId,
          nama_lengkap: actorName,
          nim_nip: '-',
          role: isAdminActor ? 'admin' : 'user',
          rfid_uid_tap: 'REMOTE',
          waktu_tap: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
          metode_akses: 'remote',
          status_akses: 'granted',
          keterangan: 'REMOTE_UNLOCK',
        });
      }

      broadcastStats();
      res.json({
        ok: true,
        message: isAdminActor
          ? `Pintu ${kodeUpper} berhasil dibuka (tetap terbuka sampai dikunci oleh Admin)`
          : `Pintu ${kodeUpper} berhasil dibuka selama ${DOOR_UNLOCK_DURATION / 1000} detik`,
        duration: isAdminActor ? 0 : DOOR_UNLOCK_DURATION
      });
    } catch (dbErr) {
      console.error('[API] Error updating door unlock state in DB:', dbErr);
      res.json({ ok: true, note: 'Signal sent via MQTT' });
    }
  });
});

// POST /api/rooms/:kode/lock - Kunci pintu secara manual dari Dashboard (Admin Only)
app.post('/api/rooms/:kode/lock', verifyToken, requireAdmin, async (req, res) => {
  const kode = req.params.kode.toLowerCase();
  const kodeUpper = kode.toUpperCase();

  const [[targetRoom]] = await db.query('SELECT id_room, kode_ruangan FROM rooms WHERE UPPER(kode_ruangan) = ?', [kodeUpper]);
  if (!targetRoom) {
    return res.status(404).json({ error: 'room_not_found', message: 'Ruangan tidak dikenali' });
  }

  if (!mqttClient.connected) {
    return res.status(503).json({
      error: 'mqtt_down',
      message: 'Broker MQTT sedang tidak terhubung. Perangkat ESP32 tidak dapat menerima perintah lock'
    });
  }

  const topicCmd = `room/${kode}/command`;
  mqttClient.publish(topicCmd, 'lock', { qos: 1 }, async (publishErr) => {
    if (publishErr) {
      console.error('[MQTT] Publish lock command failed:', publishErr);
      return res.status(502).json({ error: 'publish_failed', message: 'Gagal mengirim sinyal lock ke broker MQTT' });
    }

    try {
      if (doorRelockTimers[kodeUpper]) {
        clearTimeout(doorRelockTimers[kodeUpper]);
        delete doorRelockTimers[kodeUpper];
      }
      await db.query("UPDATE rooms SET status_pintu = 'locked' WHERE kode_ruangan = ?", [kodeUpper]);
      console.log(`[REMOTE] Pintu ${kodeUpper} dikunci secara manual oleh ${req.user.nama_lengkap}`);
      broadcast('DOOR_STATUS', { room: kodeUpper, status: 'locked' });
      broadcastStats();
      res.json({ ok: true, message: `Pintu ${kodeUpper} berhasil dikunci` });
    } catch (dbErr) {
      console.error('[API] Error updating door lock state in DB:', dbErr);
      res.json({ ok: true, note: 'Lock signal sent via MQTT' });
    }
  });
});

// ==========================================================
// REST API: MANAJEMEN JADWAL (SCHEDULES)
// ==========================================================

// GET /api/schedules/all - Daftar jadwal dengan filter
app.get('/api/schedules/all', verifyToken, async (req, res) => {
  const { date, room, status, userId, search } = req.query;

  try {
    let sql = `
      SELECT s.id_schedule, s.id_user, s.id_room, s.tanggal_akses, s.jam_mulai, s.jam_selesai,
             s.keperluan, s.status_jadwal,
             u.nim_nip, u.nama_lengkap, u.email, u.role, u.rfid_uid,
             r.kode_ruangan, r.nama_ruangan
        FROM schedules s
        JOIN users u ON u.id_user = s.id_user
        JOIN rooms r ON r.id_room = s.id_room
       WHERE 1=1
    `;
    const params = [];

    // Jika bukan admin, hanya bisa melihat semua atau difilter miliknya
    if (req.user.role !== 'admin' && userId && parseInt(userId, 10) === req.user.id_user) {
      sql += ' AND s.id_user = ?';
      params.push(req.user.id_user);
    } else if (userId) {
      sql += ' AND s.id_user = ?';
      params.push(parseInt(userId, 10));
    }

    if (date) {
      sql += ' AND s.tanggal_akses = ?';
      params.push(date);
    }

    if (room) {
      sql += ' AND (r.kode_ruangan = ? OR r.id_room = ?)';
      params.push(room.toUpperCase(), room);
    }

    if (status) {
      sql += ' AND s.status_jadwal = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (u.nama_lengkap LIKE ? OR u.nim_nip LIKE ? OR s.keperluan LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY s.tanggal_akses DESC, s.jam_mulai DESC';

    const [rows] = await db.query(sql, params);
    res.json({ schedules: rows });
  } catch (err) {
    console.error('[API] GET /api/schedules/all error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal mengambil data jadwal' });
  }
});

// POST /api/schedules - Pengajuan Jadwal Baru dengan Validasi Anti-Bentrok
app.post('/api/schedules', verifyToken, async (req, res) => {
  const { id_room, tanggal_akses, jam_mulai, jam_selesai, keperluan, id_user } = req.body;

  if (!id_room || !tanggal_akses || !jam_mulai || !jam_selesai || !keperluan) {
    return res.status(400).json({ error: 'missing_fields', message: 'Semua kolom jadwal wajib diisi' });
  }

  // Waktu selesai harus lebih besar dari waktu mulai
  if (jam_mulai >= jam_selesai) {
    return res.status(400).json({ error: 'invalid_time_range', message: 'Jam selesai harus lebih akhir dari jam mulai' });
  }

  // Tentukan id_user pemilik jadwal
  let targetUserId = req.user.id_user;
  if (req.user.role === 'admin' && id_user) {
    targetUserId = parseInt(id_user, 10);
  }

  try {
    // 1. Validasi keberadaan ruangan
    const [[room]] = await db.query(
      'SELECT id_room, kode_ruangan, nama_ruangan, jam_buka, jam_tutup FROM rooms WHERE id_room = ? OR kode_ruangan = ?',
      [id_room, String(id_room).toUpperCase()]
    );
    if (!room) {
      return res.status(404).json({ error: 'room_not_found', message: 'Ruangan yang dipilih tidak ditemukan' });
    }

    // 2. Validasi Jam Akses Operasional Ruangan (Ditetapkan oleh Admin)
    const jamBuka = room.jam_buka ? room.jam_buka.slice(0, 5) : '07:00';
    const jamTutup = room.jam_tutup ? room.jam_tutup.slice(0, 5) : '21:00';

    if (jam_mulai < jamBuka || jam_selesai > jamTutup) {
      return res.status(400).json({
        error: 'outside_operational_hours',
        message: `${room.nama_ruangan} hanya dapat diakses antara pukul ${jamBuka} s.d. ${jamTutup} WIB. Silakan sesuaikan jam pengajuan jadwal.`
      });
    }

    // 3. VALIDASI ANTI-BENTROK / OVERLAP WAKTU:
    // Dua rentang [A_start, A_end] dan [B_start, B_end] bertabrakan jika:
    // jam_mulai_lama < jam_selesai_baru DAN jam_selesai_lama > jam_mulai_baru
    const [conflicts] = await db.query(
      `SELECT s.id_schedule, s.jam_mulai, s.jam_selesai, s.status_jadwal, u.nama_lengkap
         FROM schedules s
         JOIN users u ON u.id_user = s.id_user
        WHERE s.id_room = ?
          AND s.tanggal_akses = ?
          AND s.status_jadwal IN ('approved', 'pending')
          AND s.jam_mulai < ?
          AND s.jam_selesai > ?`,
      [room.id_room, tanggal_akses, jam_selesai, jam_mulai]
    );

    if (conflicts.length > 0) {
      const clash = conflicts[0];
      return res.status(409).json({
        error: 'schedule_conflict',
        message: `Jadwal bentrok dengan jadwal lain (${clash.jam_mulai.slice(0, 5)} - ${clash.jam_selesai.slice(0, 5)} oleh ${clash.nama_lengkap}, status: ${clash.status_jadwal})`,
        conflict: clash
      });
    }

    // Admin otomatis approved, Mahasiswa/Dosen berstatus pending
    const initialStatus = req.user.role === 'admin' ? 'approved' : 'pending';

    const [result] = await db.query(
      `INSERT INTO schedules (id_user, id_room, tanggal_akses, jam_mulai, jam_selesai, keperluan, status_jadwal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [targetUserId, room.id_room, tanggal_akses, jam_mulai, jam_selesai, keperluan.trim(), initialStatus]
    );

    const newSchedule = {
      id_schedule: result.insertId,
      id_user: targetUserId,
      id_room: room.id_room,
      nama_ruangan: room.nama_ruangan,
      tanggal_akses,
      jam_mulai,
      jam_selesai,
      keperluan,
      status_jadwal: initialStatus
    };

    broadcast('SCHEDULE_UPDATE', { action: 'CREATED', schedule: newSchedule });
    broadcastStats();

    res.status(201).json({
      message: initialStatus === 'approved' ? 'Jadwal berhasil dibuat dan disetujui' : 'Pengajuan jadwal berhasil disimpan (Menunggu Persetujuan Admin)',
      schedule: newSchedule
    });
  } catch (err) {
    console.error('[API] POST /api/schedules error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal membuat jadwal baru' });
  }
});

// PATCH /api/schedules/:id/status - Persetujuan Admin (Approved/Rejected)
app.patch('/api/schedules/:id/status', verifyToken, requireAdmin, async (req, res) => {
  const scheduleId = parseInt(req.params.id, 10);
  const { status_jadwal } = req.body;

  if (!['approved', 'rejected', 'pending'].includes(status_jadwal)) {
    return res.status(400).json({ error: 'invalid_status', message: 'Status harus approved, rejected, atau pending' });
  }

  try {
    const [[schedule]] = await db.query('SELECT * FROM schedules WHERE id_schedule = ?', [scheduleId]);
    if (!schedule) {
      return res.status(404).json({ error: 'schedule_not_found', message: 'Jadwal tidak ditemukan' });
    }

    // Jika disetujui, pastikan tidak ada bentrokan dengan jadwal yang sudah approved lain
    if (status_jadwal === 'approved') {
      const [conflicts] = await db.query(
        `SELECT s.id_schedule, s.jam_mulai, s.jam_selesai, u.nama_lengkap
           FROM schedules s
           JOIN users u ON u.id_user = s.id_user
          WHERE s.id_room = ?
            AND s.tanggal_akses = ?
            AND s.status_jadwal = 'approved'
            AND s.id_schedule != ?
            AND s.jam_mulai < ?
            AND s.jam_selesai > ?`,
        [schedule.id_room, schedule.tanggal_akses, scheduleId, schedule.jam_selesai, schedule.jam_mulai]
      );

      if (conflicts.length > 0) {
        return res.status(409).json({
          error: 'schedule_conflict',
          message: `Tidak dapat menyetujui. Bentrok dengan jadwal yang telah disetujui sebelumnya (${conflicts[0].jam_mulai.slice(0, 5)} - ${conflicts[0].jam_selesai.slice(0, 5)} oleh ${conflicts[0].nama_lengkap})`
        });
      }
    }

    await db.query('UPDATE schedules SET status_jadwal = ? WHERE id_schedule = ?', [status_jadwal, scheduleId]);

    broadcast('SCHEDULE_UPDATE', { action: 'STATUS_CHANGED', id_schedule: scheduleId, status_jadwal });
    broadcastStats();

    res.json({ message: `Status jadwal berhasil diubah menjadi ${status_jadwal}`, id_schedule: scheduleId, status_jadwal });
  } catch (err) {
    console.error('[API] PATCH /api/schedules/:id/status error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal memperbarui status jadwal' });
  }
});

// DELETE /api/schedules/:id - Menghapus Jadwal
app.delete('/api/schedules/:id', verifyToken, async (req, res) => {
  const scheduleId = parseInt(req.params.id, 10);

  try {
    const [[schedule]] = await db.query('SELECT * FROM schedules WHERE id_schedule = ?', [scheduleId]);
    if (!schedule) {
      return res.status(404).json({ error: 'schedule_not_found', message: 'Jadwal tidak ditemukan' });
    }

    // Mahasiswa / Dosen hanya boleh membatalkan jadwal milik sendiri yang masih 'pending'
    if (req.user.role !== 'admin') {
      if (schedule.id_user !== req.user.id_user) {
        return res.status(403).json({ error: 'forbidden', message: 'Anda hanya dapat menghapus jadwal milik Anda sendiri' });
      }
      if (schedule.status_jadwal === 'approved') {
        return res.status(403).json({ error: 'forbidden', message: 'Jadwal yang sudah disetujui tidak dapat dihapus secara mandiri. Hubungi Admin' });
      }
    }

    await db.query('DELETE FROM schedules WHERE id_schedule = ?', [scheduleId]);

    broadcast('SCHEDULE_UPDATE', { action: 'DELETED', id_schedule: scheduleId });
    broadcastStats();

    res.json({ message: 'Jadwal berhasil dihapus', id_schedule: scheduleId });
  } catch (err) {
    console.error('[API] DELETE /api/schedules/:id error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal menghapus jadwal' });
  }
});

// ==========================================================
// REST API: MANAJEMEN PENGGUNA & KARTU RFID (ADMIN ONLY)
// ==========================================================

// GET /api/users - Mengambil daftar seluruh pengguna
app.get('/api/users', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [users] = await db.query(
      `SELECT u.id_user, u.nim_nip, u.nama_lengkap, u.rfid_uid, u.tipe_kartu, u.email, u.role,
              COUNT(s.id_schedule) as total_jadwal
         FROM users u
         LEFT JOIN schedules s ON s.id_user = u.id_user
        GROUP BY u.id_user
        ORDER BY u.role ASC, u.nama_lengkap ASC`
    );
    res.json({ users });
  } catch (err) {
    console.error('[API] GET /api/users error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal mengambil data pengguna' });
  }
});

// GET /api/users/latest-unregistered-uid - Mengambil UID Tap Terakhir yang Belum Terdaftar
app.get('/api/users/latest-unregistered-uid', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [[latestLog]] = await db.query(
      `SELECT al.rfid_uid_tap, al.waktu_tap, al.keterangan, r.nama_ruangan, r.kode_ruangan
         FROM access_logs al
         JOIN rooms r ON r.id_room = al.id_room
        WHERE (al.status_akses = 'denied' OR al.keterangan = 'UID_UNKNOWN')
          AND al.rfid_uid_tap IS NOT NULL
          AND al.rfid_uid_tap != 'REMOTE'
          AND al.rfid_uid_tap NOT IN (SELECT rfid_uid FROM users WHERE rfid_uid IS NOT NULL)
        ORDER BY al.waktu_tap DESC
        LIMIT 1`
    );

    if (!latestLog) {
      return res.json({
        found: false,
        message: 'Belum ada kartu tidak terdaftar yang baru saja di-tap di reader'
      });
    }

    res.json({
      found: true,
      uid: latestLog.rfid_uid_tap,
      waktu_tap: latestLog.waktu_tap,
      ruangan: latestLog.nama_ruangan,
      kode_ruangan: latestLog.kode_ruangan,
      keterangan: latestLog.keterangan
    });
  } catch (err) {
    console.error('[API] GET /api/users/latest-unregistered-uid error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal mencari UID tap terakhir' });
  }
});

// POST /api/users - Tambah Pengguna Baru oleh Admin
app.post('/api/users', verifyToken, requireAdmin, async (req, res) => {
  const { nim_nip, nama_lengkap, email, rfid_uid, tipe_kartu, password, role } = req.body;

  if (!nim_nip || !nama_lengkap) {
    return res.status(400).json({ error: 'missing_fields', message: 'NIM/NIP dan Nama Lengkap wajib diisi' });
  }

  const cleanUid = rfid_uid && rfid_uid.trim().length > 0 ? rfid_uid.trim().toUpperCase() : null;
  const cardLabel = tipe_kartu && tipe_kartu.trim().length > 0 ? tipe_kartu.trim() : (cleanUid ? 'Kartu RFID' : null);
  const userRole = (role && ['admin', 'dosen', 'mahasiswa'].includes(role.toLowerCase())) ? role.toLowerCase() : 'mahasiswa';
  const rawPassword = password && password.trim().length > 0 ? password.trim() : '12345678';

  try {
    // Validasi duplikat
    const [existing] = await db.query(
      'SELECT id_user FROM users WHERE nim_nip = ? OR (email = ? AND email IS NOT NULL) OR (rfid_uid = ? AND rfid_uid IS NOT NULL)',
      [nim_nip.trim(), email ? email.trim() : null, cleanUid]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: 'duplicate', message: 'NIM/NIP, Email, atau RFID UID sudah terdaftar' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(rawPassword, salt);

    const [result] = await db.query(
      `INSERT INTO users (nim_nip, nama_lengkap, email, rfid_uid, tipe_kartu, password_hash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nim_nip.trim(), nama_lengkap.trim(), email ? email.trim() : null, cleanUid, cardLabel, passwordHash, userRole]
    );

    res.status(201).json({
      message: 'Pengguna baru berhasil ditambahkan',
      user: {
        id_user: result.insertId,
        nim_nip: nim_nip.trim(),
        nama_lengkap: nama_lengkap.trim(),
        email: email ? email.trim() : null,
        rfid_uid: cleanUid,
        tipe_kartu: cardLabel,
        role: userRole
      }
    });
  } catch (err) {
    console.error('[API] POST /api/users error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal menambahkan data pengguna' });
  }
});

// PUT /api/users/:id - Edit Data Pengguna
app.put('/api/users/:id', verifyToken, requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { nim_nip, nama_lengkap, email, rfid_uid, tipe_kartu, role, password } = req.body;

  if (!nim_nip || !nama_lengkap) {
    return res.status(400).json({ error: 'missing_fields', message: 'NIM/NIP dan Nama Lengkap wajib diisi' });
  }

  const cleanUid = rfid_uid && rfid_uid.trim().length > 0 ? rfid_uid.trim().toUpperCase() : null;
  const cardLabel = tipe_kartu && tipe_kartu.trim().length > 0 ? tipe_kartu.trim() : (cleanUid ? 'Kartu RFID' : null);
  const userRole = (role && ['admin', 'dosen', 'mahasiswa'].includes(role.toLowerCase())) ? role.toLowerCase() : 'mahasiswa';

  try {
    // Validasi bentrok duplikasi dengan pengguna lain
    const [duplicates] = await db.query(
      `SELECT id_user FROM users 
        WHERE id_user != ? AND (
          nim_nip = ? OR 
          (email = ? AND email IS NOT NULL) OR 
          (rfid_uid = ? AND rfid_uid IS NOT NULL)
        )`,
      [userId, nim_nip.trim(), email ? email.trim() : null, cleanUid]
    );

    if (duplicates.length > 0) {
      return res.status(409).json({ error: 'duplicate', message: 'NIM/NIP, Email, atau RFID UID telah digunakan oleh pengguna lain' });
    }

    if (password && password.trim().length > 0) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(password.trim(), salt);
      await db.query(
        `UPDATE users 
            SET nim_nip = ?, nama_lengkap = ?, email = ?, rfid_uid = ?, tipe_kartu = ?, role = ?, password_hash = ?
          WHERE id_user = ?`,
        [nim_nip.trim(), nama_lengkap.trim(), email ? email.trim() : null, cleanUid, cardLabel, userRole, passwordHash, userId]
      );
    } else {
      await db.query(
        `UPDATE users 
            SET nim_nip = ?, nama_lengkap = ?, email = ?, rfid_uid = ?, tipe_kartu = ?, role = ?
          WHERE id_user = ?`,
        [nim_nip.trim(), nama_lengkap.trim(), email ? email.trim() : null, cleanUid, cardLabel, userRole, userId]
      );
    }

    res.json({
      message: 'Data pengguna berhasil diperbarui',
      user: {
        id_user: userId,
        nim_nip: nim_nip.trim(),
        nama_lengkap: nama_lengkap.trim(),
        email: email ? email.trim() : null,
        rfid_uid: cleanUid,
        tipe_kartu: cardLabel,
        role: userRole
      }
    });
  } catch (err) {
    console.error('[API] PUT /api/users/:id error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal memperbarui pengguna' });
  }
});

// DELETE /api/users/:id - Hapus Pengguna
app.delete('/api/users/:id', verifyToken, requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);

  if (userId === req.user.id_user) {
    return res.status(400).json({ error: 'cannot_delete_self', message: 'Anda tidak dapat menghapus akun Anda sendiri' });
  }

  try {
    await db.query('DELETE FROM users WHERE id_user = ?', [userId]);
    res.json({ message: 'Pengguna berhasil dihapus', id_user: userId });
  } catch (err) {
    console.error('[API] DELETE /api/users/:id error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal menghapus pengguna' });
  }
});

// ==========================================================
// REST API: RIWAYAT AKSES & AUDIT LOG
// ==========================================================

// GET /api/logs - Paginasi, Filter & Search
app.get('/api/logs', verifyToken, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const offset = (page - 1) * limit;

  const { room, method, status, startDate, endDate, search } = req.query;

  try {
    let whereClause = ' WHERE 1=1';
    const params = [];

    if (room) {
      whereClause += ' AND (r.kode_ruangan = ? OR r.id_room = ?)';
      params.push(room.toUpperCase(), room);
    }

    if (method && ['rfid', 'remote'].includes(method)) {
      whereClause += ' AND al.metode_akses = ?';
      params.push(method);
    }

    if (status && ['granted', 'denied'].includes(status)) {
      whereClause += ' AND al.status_akses = ?';
      params.push(status);
    }

    if (startDate) {
      whereClause += ' AND DATE(al.waktu_tap) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      whereClause += ' AND DATE(al.waktu_tap) <= ?';
      params.push(endDate);
    }

    if (search) {
      whereClause += ' AND (u.nama_lengkap LIKE ? OR u.nim_nip LIKE ? OR al.rfid_uid_tap LIKE ? OR al.keterangan LIKE ?)';
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    // Hitung total baris untuk pagination
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) as total
         FROM access_logs al
         JOIN rooms r ON r.id_room = al.id_room
         LEFT JOIN users u ON u.id_user = al.id_user
       ${whereClause}`,
      params
    );

    // Ambil baris data
    const [rows] = await db.query(
      `SELECT al.id_log, al.id_room, al.id_user, al.id_schedule, al.rfid_uid_tap,
              al.waktu_tap, al.metode_akses, al.status_akses, al.keterangan,
              r.kode_ruangan, r.nama_ruangan,
              u.nim_nip, u.nama_lengkap, u.role, u.email
         FROM access_logs al
         JOIN rooms r ON r.id_room = al.id_room
         LEFT JOIN users u ON u.id_user = al.id_user
       ${whereClause}
        ORDER BY al.waktu_tap DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({
      data: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  } catch (err) {
    console.error('[API] GET /api/logs error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal mengambil riwayat akses' });
  }
});

// GET /api/logs/export - Unduh Riwayat Akses Format CSV
app.get('/api/logs/export', verifyToken, async (req, res) => {
  const { room, method, status, startDate, endDate } = req.query;

  try {
    let whereClause = ' WHERE 1=1';
    const params = [];

    if (room) {
      whereClause += ' AND (r.kode_ruangan = ? OR r.id_room = ?)';
      params.push(room.toUpperCase(), room);
    }
    if (method) {
      whereClause += ' AND al.metode_akses = ?';
      params.push(method);
    }
    if (status) {
      whereClause += ' AND al.status_akses = ?';
      params.push(status);
    }
    if (startDate) {
      whereClause += ' AND DATE(al.waktu_tap) >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND DATE(al.waktu_tap) <= ?';
      params.push(endDate);
    }

    const [rows] = await db.query(
      `SELECT al.id_log, r.kode_ruangan, r.nama_ruangan, al.waktu_tap,
              al.metode_akses, al.status_akses, al.keterangan,
              COALESCE(u.nim_nip, '-') as nim_nip,
              COALESCE(u.nama_lengkap, 'Unregistered') as nama_lengkap,
              COALESCE(u.role, '-') as role,
              al.rfid_uid_tap
         FROM access_logs al
         JOIN rooms r ON r.id_room = al.id_room
         LEFT JOIN users u ON u.id_user = al.id_user
       ${whereClause}
        ORDER BY al.waktu_tap DESC`,
      params
    );

    // Format string CSV
    let csv = 'ID,Kode Ruangan,Nama Ruangan,Waktu Akses,Metode,Status,Keterangan,NIM/NIP,Nama Pengguna,Role,RFID UID\r\n';
    rows.forEach(r => {
      const escape = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
      csv += [
        r.id_log,
        escape(r.kode_ruangan),
        escape(r.nama_ruangan),
        escape(r.waktu_tap),
        escape(r.metode_akses),
        escape(r.status_akses),
        escape(r.keterangan),
        escape(r.nim_nip),
        escape(r.nama_lengkap),
        escape(r.role),
        escape(r.rfid_uid_tap)
      ].join(',') + '\r\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=access_logs_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[API] GET /api/logs/export error:', err);
    res.status(500).json({ error: 'export_failed', message: 'Gagal membuat file export CSV' });
  }
});

// GET /api/stats - Ringkasan Statistik
app.get('/api/stats', async (req, res) => {
  try {
    const [[{ totalAksesHariIni }]] = await db.query(
      'SELECT COUNT(*) as totalAksesHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE()'
    );
    const [[{ aksesGrantedHariIni }]] = await db.query(
      "SELECT COUNT(*) as aksesGrantedHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE() AND status_akses = 'granted'"
    );
    const [[{ aksesDeniedHariIni }]] = await db.query(
      "SELECT COUNT(*) as aksesDeniedHariIni FROM access_logs WHERE DATE(waktu_tap) = CURDATE() AND status_akses = 'denied'"
    );
    const [[{ jadwalPending }]] = await db.query(
      "SELECT COUNT(*) as jadwalPending FROM schedules WHERE status_jadwal = 'pending'"
    );
    const [[{ jadwalHariIni }]] = await db.query(
      "SELECT COUNT(*) as jadwalHariIni FROM schedules WHERE status_jadwal = 'approved' AND tanggal_akses = CURDATE()"
    );
    const [[{ perangkatOnline }]] = await db.query(
      "SELECT COUNT(*) as perangkatOnline FROM rooms WHERE status_device = 'online'"
    );
    const [[{ totalRuangan }]] = await db.query(
      'SELECT COUNT(*) as totalRuangan FROM rooms'
    );

    const [rooms] = await db.query(
      'SELECT id_room, kode_ruangan, nama_ruangan, status_pintu, status_device FROM rooms ORDER BY id_room ASC'
    );

    res.json({
      totalAksesHariIni,
      aksesGrantedHariIni,
      aksesDeniedHariIni,
      jadwalPending,
      jadwalHariIni,
      perangkatOnline,
      totalRuangan,
      rooms
    });
  } catch (err) {
    console.error('[API] GET /api/stats error:', err);
    res.status(500).json({ error: 'db_error', message: 'Gagal mengambil statistik sistem' });
  }
});

// ==========================================================
// SPA FALLBACK ROUTE
// ==========================================================
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ==========================================================
// START SERVER
// ==========================================================
server.listen(PORT, () => {
  console.log('==========================================================');
  console.log(`🚀 Smart Scheduled Room Access System Server Aktif`);
  console.log(`🌐 REST API & Web Dashboard: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket Server: ws://localhost:${PORT}`);
  console.log(`📡 Menghubungkan MQTT ke: ${MQTT_BROKER}`);
  console.log('==========================================================');
});
