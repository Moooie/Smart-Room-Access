# Smart Scheduled Room Access System
### Full-Stack IoT Application (Layer 3: API/Gateway & Layer 4: Application Layer)

Sistem Pengendalian Akses Ruangan Terjadwal berbasis IoT menggunakan mikrokontroler **NodeMCU ESP32**, modul RFID **MFRC522**, LiquidCrystal I2C, Solenoid Door Lock, protokol **MQTT**, **REST API Express**, database **MySQL**, dan antarmuka **Web Dashboard Real-Time** (WebSocket + Tailwind CSS).

---

## 📁 Struktur Direktori Proyek

```text
d:\iot project smart\
├── backend/
│   ├── server.js              # Server Express, WebSocket ws, MQTT client, REST API & RBAC
│   ├── package.json           # Dependensi Node.js backend
│   ├── .env                   # Variabel lingkungan aktif
│   └── .env.example           # Contoh konfigurasi .env
├── frontend/
│   ├── index.html             # Single-Page Web Dashboard responsive (Tailwind CSS)
│   ├── css/
│   │   └── custom.css         # Animasi countdown, glow unlock, custom badge
│   └── js/
│       └── app.js             # Logika dashboard, WebSocket listener, REST client, Auto-Fill UID
├── database/
│   └── smart_room.sql         # Skema database & seeder lengkap (XAMPP / MySQL)
├── mosquitto/
│   ├── mosquitto.conf         # Konfigurasi broker Mosquitto MQTT port 1883
│   └── README.md              # Petunjuk konfigurasi broker Mosquitto
├── SmartRoomAccess_ESP32__1_.ino # Kode firmware mikrokontroler ESP32
├── server.js                  # Entrypoint runner di root
├── package.json               # Package root untuk `npm start`
└── README.md                  # Dokumentasi teknis lengkap ini
```

---

## 🔑 Akun Demo Default (Tersedia di Seeder Database)

| Peran (Role) | NIM / NIP | Email | Kata Sandi (Password) | RFID UID Fisik | Hak Akses |
|---|---|---|---|---|---|
| **Administrator** | `ADMIN01` | `admin@example.com` | `admin123` | `04:A2:3B:5C` | Akses penuh: Approve/Reject jadwal, CRUD Pengguna, Auto-Fill RFID, Remote Unlock kapan saja |
| **Mahasiswa** | `123240018` | `ari@example.com` | `mahasiswa123` | `AA:BB:CC:DD` | Ajukan jadwal, batalkan pengajuan mandiri, Remote Unlock jika jadwal aktif |
| **Dosen** | `198501012010121001` | `dosen@example.com` | `dosen123` | `B2:C3:D4:E5` | Ajukan jadwal prioritas, Remote Unlock jika jadwal aktif |
| **Mahasiswa 2** | `123240099` | `siti@example.com` | `mahasiswa123` | `C3:D4:E5:F6` | Ajukan jadwal, Remote Unlock jika jadwal aktif |

> *Catatan: Pada modal Login di Web Dashboard, tersedia tombol "Pilih Akun Demo Cepat" untuk mengisi formulir login hanya dengan 1 klik.*

---

## 🚀 Panduan Instalasi & Eksekusi Langkah Demi Langkah

### Langkah 1: Setup Database MySQL di XAMPP
1. Buka **XAMPP Control Panel**, lalu klik tombol **Start** pada modul **MySQL** (dan **Apache** jika diinginkan).
2. Buka browser dan akses **phpMyAdmin** di `http://localhost/phpmyadmin/`.
3. Klik tab **Import** pada menu atas.
4. Pilih file `database/smart_room.sql` (atau `smart_room.sql`), lalu klik tombol **Go / Kirim** di bawah.
5. Database `smart_room` beserta 4 tabel (`users`, `rooms`, `schedules`, `access_logs`) dan data awal contoh akan terbuat otomatis.

---

### Langkah 2: Jalankan Mosquitto MQTT Broker
Sistem menggunakan port TCP `1883` untuk komunikasi antara ESP32 dan Backend.

1. Buka PowerShell atau Command Prompt baru.
2. Jalankan perintah berikut:
   ```powershell
   & "C:\Program Files\mosquitto\mosquitto.exe" -c "d:\iot project smart\mosquitto\mosquitto.conf" -v
   ```
   *(Atau jalankan service Mosquitto bawaan Windows melalui `services.msc` -> `Mosquitto Broker` -> `Start`)*.

---

### Langkah 3: Jalankan Backend Node.js & Web Dashboard
1. Buka terminal di folder proyek:
   ```powershell
   cd "d:\iot project smart"
   npm install
   npm start
   ```
2. Terminal akan menampilkan konfirmasi:
   ```text
   ==========================================================
   🚀 Smart Scheduled Room Access System Server Aktif
   🌐 REST API & Web Dashboard: http://localhost:3000
   ⚡ WebSocket Server: ws://localhost:3000
   📡 Menghubungkan MQTT ke: mqtt://localhost:1883
   ==========================================================
   ```
3. Buka browser dan buka alamat: **`http://localhost:3000`**

---

### Langkah 4: Konfigurasi & Upload Firmware ESP32
1. Buka file `SmartRoomAccess_ESP32__1_.ino` di **Arduino IDE**.
2. Pastikan library berikut sudah terinstall di Arduino Library Manager:
   - `MFRC522` by GithubCommunity
   - `LiquidCrystal_I2C` by Frank de Brabander
   - `ArduinoJson` (v7) by Benoit Blanchon
   - `PubSubClient` by Nick O'Leary
3. Sesuaikan konstanta jaringan pada baris 17-29:
   ```cpp
   const char* WIFI_SSID  = "Nama_WiFi_Anda";
   const char* WIFI_PASS  = "Password_WiFi_Anda";
   
   const char* ROOM_ID    = "MERAH"; // "MERAH" | "KUNING" | "HIJAU"
   const char* ROOM_NAME  = "Ruang Merah";
   
   // Ganti IP dengan alamat IP laptop/PC server Anda di jaringan lokal (misal: 192.168.1.10)
   const char* API_URL    = "http://192.168.1.10:3000/api/schedules";
   const char* MQTT_HOST  = "192.168.1.10";
   const uint16_t MQTT_PORT = 1883;
   ```
4. Upload firmware ke masing-masing ESP32 sesuai ruangan (`MERAH`, `KUNING`, `HIJAU`).

---

## 🛠️ Pengujian Tanpa Hardware Fisik (Simulasi ESP32)

Jika perangkat keras ESP32 belum terhubung, Anda dapat mensimulasikan aktivitas hardware menggunakan perintah MQTT berikut:

### 1. Simulasi ESP32 Online / Offline
Kirim retained status perangkat:
```powershell
# Mengubah Ruang Merah menjadi Online
mosquitto_pub -h localhost -p 1883 -t "room/merah/status" -m "online" -r

# Mengubah Ruang Merah menjadi Offline
mosquitto_pub -h localhost -p 1883 -t "room/merah/status" -m "offline" -r
```

### 2. Simulasi Tap Kartu RFID (Akses Diterima / Granted)
```powershell
mosquitto_pub -h localhost -p 1883 -t "room/merah/access-log" -m '{"room":"MERAH","uid":"AA:BB:CC:DD","status":"granted","reason":"OK","method":"rfid"}'
```
*Hasil di Dashboard:* Status pintu Ruang Merah langsung berubah menjadi **TERBUKA (UNLOCKED)**, animasi countdown 4 detik aktif, dan log akses masuk ke tabel secara real-time.

### 3. Simulasi Tap Kartu Tidak Dikenal (Akses Ditolak & Auto-Fill RFID)
```powershell
mosquitto_pub -h localhost -p 1883 -t "room/kuning/access-log" -m '{"room":"KUNING","uid":"E2:3A:4F:91","status":"denied","reason":"UID_UNKNOWN","method":"rfid"}'
```
*Hasil di Dashboard:*
1. Muncul toast merah "Akses Ditolak: Kartu Tidak Ada".
2. Buka tab **Pengguna & RFID**, klik tombol **"Tambah Pengguna Baru"**, lalu klik tombol **"⚡ Auto-Fill UID dari Tap Terakhir"**.
3. UID `E2:3A:4F:91` akan langsung terisi secara otomatis tanpa perlu mengetik!

---

## 📑 Spesifikasi REST API & Gateway

### 1. Autentikasi (`/api/auth`)
* `POST /api/auth/login`: Login dengan NIM/NIP atau Email + Password. Mengembalikan JWT Bearer token.
* `POST /api/auth/register`: Mendaftarkan user baru (role default: `mahasiswa`).
* `GET /api/auth/me`: Mengambil profil user yang sedang login dari token.

### 2. Jadwal ESP32 (`/api/schedules` - Backward Compatible)
* `GET /api/schedules?room=MERAH`:
  - Header: `x-api-key: KELOMPOKIOTEMAS`
  - Mengembalikan daftar JSON jadwal aktif hari ini dan besok untuk cache SPIFFS ESP32:
    `[{"uid":"AA:BB:CC:DD","roomId":"MERAH","date":"2026-11-18","start":"00:00","end":"23:59","approved":true}]`

### 3. Ruangan & Remote Unlock (`/api/rooms`)
* `GET /api/rooms`: Mengambil data ruangan (1 unit ESP32), status perangkat, status pintu, dan jadwal aktif saat ini.
* `POST /api/rooms/:kode/unlock`:
  - Membuka pintu solenoid via MQTT `room/<kode>/command` payload `"unlock"`.
  - Otomatis relock dalam 4000ms.
  - Otorisasi: Admin dapat membuka kapan saja; Dosen/Mahasiswa hanya jika memiliki jadwal `approved` yang aktif pada jam saat ini.

### 4. Manajemen Jadwal (`/api/schedules`)
* `GET /api/schedules/all`: Menampilkan seluruh jadwal dengan filter tanggal, ruangan, status, atau pengguna.
* `POST /api/schedules`: Mengajukan jadwal baru. Memiliki algoritma validasi matematis anti-bentrok waktu:
  $$ \text{jam\_mulai}_{\text{lama}} < \text{jam\_selesai}_{\text{baru}} \quad \text{DAN} \quad \text{jam\_selesai}_{\text{lama}} > \text{jam\_mulai}_{\text{baru}} $$
* `PATCH /api/schedules/:id/status`: Menyetujui (`approved`) atau menolak (`rejected`) jadwal (Khusus Admin).
* `DELETE /api/schedules/:id`: Membatalkan/menghapus jadwal.

### 5. Manajemen Pengguna & Kartu RFID (`/api/users`)
* `GET /api/users`: Daftar pengguna (Admin only).
* `POST /api/users`: Tambah pengguna baru (Admin only).
* `PUT /api/users/:id`: Edit data pengguna (Admin only).
* `DELETE /api/users/:id`: Hapus pengguna (Admin only).
* `GET /api/users/latest-unregistered-uid`: Mengambil kartu RFID tidak dikenal yang baru saja di-tap di reader mana pun.

### 6. Riwayat Akses & Audit Log (`/api/logs`)
* `GET /api/logs`: Riwayat tap RFID dengan paginasi, pencarian, dan filter.
* `GET /api/logs/export`: Download laporan lengkap format CSV.
* `GET /api/stats`: Ringkasan statistik (akses hari ini, pending, online devices).

---

## 💡 Fitur Unggulan Sistem

1. **Kompatibilitas Penuh Firmware**: Tidak memerlukan perubahan pada firmware C++ ESP32 existing; endpoint `GET /api/schedules` dengan `x-api-key: KELOMPOKIOTEMAS` dan topik MQTT `room/+/status`, `room/+/access-log`, `room/+/command` bekerja 100% presisi.
2. **Sinkronisasi Real-Time WebSocket**: Perubahan status pintu, perubahan status online ESP32, dan tap kartu RFID langsung muncul di layar semua browser dalam hitungan milidetik tanpa refresh.
3. **Validasi Anti-Bentrok Cerdas**: Mencegah peminjaman ruang pada jam yang tumpang tindih.
4. **Auto-Fill UID RFID**: Mempermudah administrator mendaftarkan kartu fisik baru hanya dengan menempelkan kartu di pembaca lalu mengklik tombol auto-fill.
5. **Role-Based Access Control (RBAC)**: Proteksi multi-tingkat antara Administrator, Dosen, dan Mahasiswa.
