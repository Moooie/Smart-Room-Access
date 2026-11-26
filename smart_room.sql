-- ==========================================================
-- Smart Scheduled Room Access System
-- Skema Database & Data Awal (Seeder)
-- 3 Ruangan dengan Pengaturan Jam Akses Operasional (jam_buka & jam_tutup)
-- ==========================================================

CREATE DATABASE IF NOT EXISTS smart_room CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE smart_room;

-- 1. Tabel Users
CREATE TABLE IF NOT EXISTS users (
  id_user       INT AUTO_INCREMENT PRIMARY KEY,
  nim_nip       VARCHAR(30)  NOT NULL UNIQUE,
  nama_lengkap  VARCHAR(100) NOT NULL,
  rfid_uid      VARCHAR(20)  UNIQUE,
  tipe_kartu    VARCHAR(50)  DEFAULT 'Kartu RFID',
  email         VARCHAR(100) UNIQUE,
  password_hash VARCHAR(255),
  role          ENUM('admin','dosen','mahasiswa') NOT NULL DEFAULT 'mahasiswa'
) ENGINE=InnoDB;

-- 2. Tabel Rooms (3 Ruangan: Merah, Kuning, Hijau dengan Jam Akses Operasional)
CREATE TABLE IF NOT EXISTS rooms (
  id_room       INT AUTO_INCREMENT PRIMARY KEY,
  kode_ruangan  VARCHAR(20) NOT NULL UNIQUE,
  nama_ruangan  VARCHAR(50) NOT NULL,
  device_id     VARCHAR(50) UNIQUE,
  status_pintu  ENUM('locked','unlocked') NOT NULL DEFAULT 'locked',
  status_device ENUM('online','offline')  NOT NULL DEFAULT 'offline',
  jam_buka      TIME NOT NULL DEFAULT '07:00:00',
  jam_tutup     TIME NOT NULL DEFAULT '21:00:00'
) ENGINE=InnoDB;

-- 3. Tabel Schedules
CREATE TABLE IF NOT EXISTS schedules (
  id_schedule   INT AUTO_INCREMENT PRIMARY KEY,
  id_user       INT NOT NULL,
  id_room       INT NOT NULL,
  tanggal_akses DATE NOT NULL,
  jam_mulai     TIME NOT NULL,
  jam_selesai   TIME NOT NULL,
  keperluan     VARCHAR(255),
  status_jadwal ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  FOREIGN KEY (id_user) REFERENCES users(id_user) ON DELETE CASCADE,
  FOREIGN KEY (id_room) REFERENCES rooms(id_room) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Tabel Access Logs
CREATE TABLE IF NOT EXISTS access_logs (
  id_log       BIGINT AUTO_INCREMENT PRIMARY KEY,
  id_room      INT NOT NULL,
  id_user      INT NULL,
  id_schedule  INT NULL,
  rfid_uid_tap VARCHAR(20),
  waktu_tap    DATETIME NOT NULL,
  metode_akses ENUM('rfid','remote') NOT NULL DEFAULT 'rfid',
  status_akses ENUM('granted','denied') NOT NULL,
  keterangan   VARCHAR(100),
  FOREIGN KEY (id_room)     REFERENCES rooms(id_room),
  FOREIGN KEY (id_user)     REFERENCES users(id_user) ON DELETE SET NULL,
  FOREIGN KEY (id_schedule) REFERENCES schedules(id_schedule) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ==========================================================
-- DATA SEEDER AWAL
-- ==========================================================

-- A. Data Ruangan (3 Ruangan: Merah, Kuning, Hijau)
INSERT INTO rooms (id_room, kode_ruangan, nama_ruangan, device_id, status_pintu, status_device, jam_buka, jam_tutup) VALUES
  (1, 'MERAH',  'Ruang Merah',  'esp32-merah',  'locked', 'offline', '07:00:00', '21:00:00'),
  (2, 'KUNING', 'Ruang Kuning', 'esp32-kuning', 'locked', 'offline', '07:00:00', '21:00:00'),
  (3, 'HIJAU',  'Ruang Hijau',  'esp32-hijau',  'locked', 'offline', '07:00:00', '21:00:00')
ON DUPLICATE KEY UPDATE 
  nama_ruangan = VALUES(nama_ruangan),
  device_id = VALUES(device_id),
  jam_buka = VALUES(jam_buka),
  jam_tutup = VALUES(jam_tutup);

-- B. Data Pengguna Default (Password Hash Bcrypt)
INSERT INTO users (id_user, nim_nip, nama_lengkap, rfid_uid, email, password_hash, role) VALUES
  (1, 'ADMIN01',            'Administrator Lab IoT', '04:A2:3B:5C', 'admin@example.com', '$2a$10$pcnTwdd115XoCz/69.sDYuzlCLBKDwnE2sPo.6VFrROxIqt9qqLLe', 'admin'),
  (2, '123240018',          'Ari Satriya Dinata',   'AA:BB:CC:DD', 'ari@example.com',   '$2a$10$0gf/60eq9vgDHqMLLxjMB.bU8rUANwAFZbBVBnBUG7BWeMdyPv9AK', 'mahasiswa'),
  (3, '198501012010121001', 'Dr. Budi Santoso, M.T.', 'B2:C3:D4:E5', 'dosen@example.com', '$2a$10$ZobUDiq0EmccJuIFXcraKeHVPEBcHJkFnOPkbL4qaEplrJVQ5J.Gy', 'dosen'),
  (4, '123240099',          'Siti Nurhaliza',        'C3:D4:E5:F6', 'siti@example.com',  '$2a$10$0gf/60eq9vgDHqMLLxjMB.bU8rUANwAFZbBVBnBUG7BWeMdyPv9AK', 'mahasiswa')
ON DUPLICATE KEY UPDATE 
  nama_lengkap = VALUES(nama_lengkap),
  rfid_uid = VALUES(rfid_uid),
  password_hash = VALUES(password_hash),
  role = VALUES(role);

-- C. Data Jadwal Contoh untuk Tiap Ruangan
INSERT INTO schedules (id_user, id_room, tanggal_akses, jam_mulai, jam_selesai, keperluan, status_jadwal) VALUES
  (2, 1, CURDATE(), '08:00:00', '11:00:00', 'Praktikum & Uji Coba Smart Access', 'approved'),
  (3, 2, CURDATE(), '09:00:00', '15:00:00', 'Bimbingan Riset Komputasi Awan', 'approved'),
  (4, 3, DATE_ADD(CURDATE(), INTERVAL 1 DAY), '13:00:00', '15:30:00', 'Diskusi Kelompok Robotika', 'pending');

-- D. Data Log Akses Awal
INSERT INTO access_logs (id_room, id_user, id_schedule, rfid_uid_tap, waktu_tap, metode_akses, status_akses, keterangan) VALUES
  (1, 2, 1, 'AA:BB:CC:DD', NOW() - INTERVAL 45 MINUTE, 'rfid',   'granted', 'OK'),
  (1, 1, NULL, 'REMOTE',      NOW() - INTERVAL 30 MINUTE, 'remote', 'granted', 'REMOTE_UNLOCK'),
  (2, NULL, NULL, '99:88:77:66', NOW() - INTERVAL 10 MINUTE, 'rfid',   'denied',  'UID_UNKNOWN'),
  (3, 4, NULL, 'C3:D4:E5:F6', NOW() - INTERVAL 5 MINUTE,  'rfid',   'denied',  'SCHEDULE_MISMATCH');
