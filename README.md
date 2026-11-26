# Smart Scheduled Room Access System

> **Proyek Akhir Praktikum Internet of Things (IoT)** — Semester Gasal 2026/2027  
> UPN "Veteran" Yogyakarta

## Tema Proyek
**Sistem akses ruangan berbasis IoT dengan autentikasi RFID dan pengaturan akses berdasarkan jadwal waktu.**

## Deskripsi
Smart Scheduled Room Access System merupakan sistem pengunci dan pengelola akses ruangan berbasis Internet of Things (IoT). Sistem menggunakan ESP32 sebagai pengendali utama, RFID untuk mengenali kartu pengguna, LCD untuk menampilkan status, serta relay dan solenoid door-lock sebagai aktuator pengunci pintu.

Akses ruangan ditentukan berdasarkan identitas RFID dan jadwal waktu yang berlaku. Sistem juga terhubung ke dashboard web untuk pemantauan aktivitas akses.

## Fitur Utama
- **Autentikasi RFID:** membaca kartu/tag RFID dan memeriksa hak akses.
- **Akses berbasis jadwal:** akses ruangan diberikan sesuai aturan jadwal waktu.
- **Pengendalian pengunci pintu:** relay mengendalikan solenoid door-lock.
- **Informasi LCD:** menampilkan status atau respons akses.
- **IoT dan dashboard:** data perangkat dikirim melalui koneksi internet untuk pemantauan.
- **Log akses:** aktivitas akses ditampilkan pada dashboard, sesuai implementasi sistem.

## Ruangan
Sistem prototipe mengelola tiga ruangan:
- 🔴 **Ruangan Merah**
- 🟡 **Ruangan Kuning**
- 🟢 **Ruangan Hijau**

> Aturan jadwal dan pemetaan kartu mengikuti konfigurasi yang diterapkan pada program perangkat.

## Gambaran Arsitektur
1. **Perception Layer:** RFID reader, LCD, relay, dan solenoid door-lock sebagai perangkat input/output.
2. **Network Layer:** ESP32 terhubung ke jaringan Wi-Fi untuk komunikasi data.
3. **Processing Layer:** ESP32 memproses identitas RFID, aturan akses, dan waktu/jadwal.
4. **Application Layer:** dashboard web menampilkan informasi dan aktivitas sistem.

## Komponen
| Komponen | Fungsi |
|---|---|
| ESP32 | Pengendali utama dan pemroses aturan akses |
| RFID reader (MFRC522) | Membaca identitas kartu/tag RFID |
| RFID card/tag | Media identifikasi pengguna |
| LCD 16x2 I2C | Menampilkan status sistem dan akses |
| Relay | Mengendalikan rangkaian aktuator |
| Solenoid door-lock | Mengunci atau membuka mekanisme pintu |
| Wi-Fi | Menghubungkan perangkat dengan layanan/dashboard |

## Dashboard
Dashboard web proyek dapat diakses melalui:

**https://smart-room-access-production.up.railway.app**

Dashboard digunakan sebagai antarmuka pemantauan sistem dan aktivitas akses yang tersedia pada implementasi.

## Alur Kerja Singkat
1. Perangkat dinyalakan dan ESP32 menyiapkan komponen serta koneksi yang diperlukan.
2. Pengguna menempelkan kartu/tag RFID pada reader.
3. ESP32 membaca identitas kartu dan memeriksa apakah kartu terdaftar serta memenuhi aturan akses dan jadwal.
4. LCD menampilkan respons sistem.
5. Jika akses diizinkan, relay mengendalikan solenoid door-lock untuk membuka akses sesuai mekanisme sistem. Jika tidak diizinkan, akses ditolak.
6. Informasi aktivitas dikirim ke dashboard melalui koneksi IoT, sesuai kondisi konektivitas dan implementasi.

## Skenario Pengujian
Skenario pengujian yang direncanakan untuk demonstrasi dan dokumentasi:
1. Pengujian RFID untuk akses pada tiga ruangan.
2. Pengujian RFID pada ruangan yang tidak sesuai hak akses.
3. Pengujian respons LCD.
4. Pengujian respons solenoid door-lock.

Hasil pengujian perlu dicatat berdasarkan hasil aktual implementasi.

## Struktur Repository
Struktur berikut merupakan rekomendasi penataan repository; sesuaikan dengan file yang benar-benar digunakan:

```text
.
├── README.md
├── src/                 # Program utama ESP32 (jika digunakan)
├── test/                # Program pengujian komponen (jika tersedia)
├── docs/                # Diagram, dokumentasi, dan gambar proyek
└── ...
```

## Dokumentasi
Dokumentasi proyek dapat mencakup:
- Diagram blok/arsitektur sistem.
- Flowchart sistem.
- Diagram wiring dan konfigurasi pin.
- Foto implementasi prototipe.
- Dokumentasi dan tabel hasil pengujian.

## Catatan Keamanan dan Repositori
- Jangan mengunggah kata sandi, token, API key, atau kredensial pribadi.
- Pastikan file konfigurasi sensitif tidak ikut masuk ke repository.
- Pastikan isi repository mencerminkan implementasi proyek yang sebenarnya.
- Periksa akses repository agar dapat ditinjau oleh asisten laboratorium.

## Identitas Proyek
**Nama:** Smart Scheduled Room Access System  
**Institusi:** UPN "Veteran" Yogyakarta  
**Mata Praktikum:** Praktikum Internet of Things (IoT)  
**Tahun Akademik:** 2026/2027
