// Smart Scheduled Room Access System - Firmware ESP32
// Mengontrol 3 Ruangan (Ruang Merah, Ruang Kuning, Ruang Hijau)
// Menggunakan 1 unit ESP32 dengan 3 Reader RFID MFRC522 + 3 Relay Solenoid + 1 LCD I2C

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WiFiManager.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <SPIFFS.h>
#include <SPI.h>
#include <Wire.h>
#include <MFRC522.h>
#include <LiquidCrystal_I2C.h>
#include <time.h>

// ==========================================
// KONFIGURASI WI-FI & SERVER
// ==========================================
const char* WIFI_SSID    = "Sambilegi 21";
const char* WIFI_PASS    = "maguwoharjo";

const char* API_SYNC     = "https://smart-room-access-production.up.railway.app/api/esp-sync";
const char* API_KEY      = "KELOMPOKIOTEMAS";

const char* MQTT_HOST    = "ua921aa1.ala.asia-southeast1.emqxsl.com";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USER    = "smartroom-expo";
const char* MQTT_PASS    = "smartroom-expo-IF-A";

// ==========================================
// PIN BUS SPI BERSAMA (PARALEL KE 3 RFID)
// SCK  -> D18
// MISO -> D19
// MOSI -> D23
// ==========================================

// PIN 3 UNIT RFID RC522 (SDA/SS & RST TERPISAH)
#define SS_1_PIN        5     // RFID 1 (Ruang Merah)
#define RST_1_PIN       32

#define SS_2_PIN        15    // RFID 2 (Ruang Kuning)
#define RST_2_PIN       26

#define SS_3_PIN        27    // RFID 3 (Ruang Hijau)
#define RST_3_PIN       33

// PIN RELAY SOLENOID (1 PER RUANGAN)
#define RELAY_1_PIN     4     // Solenoid Ruang Merah
#define RELAY_2_PIN     13    // Solenoid Ruang Kuning
#define RELAY_3_PIN     25    // Solenoid Ruang Hijau

// PIN I2C LCD 16x2
#define I2C_SDA         21
#define I2C_SCL         22

// PARAMETER LOGIKA RELAY
#define RELAY_KUNCI     LOW   // Ubah ke HIGH jika modul relay Active-LOW
#define RELAY_BUKA      HIGH  // Ubah ke LOW jika modul relay Active-LOW

const unsigned long OPEN_MS        = 4000;     // durasi solenoid terbuka (4 detik)
const unsigned long FETCH_INTERVAL = 180000;   // backup sync tiap 3 menit (update real-time via MQTT room/sync)
const long          CACHE_TTL_SEC  = 86400;    // cache berlaku 24 jam

// Objek Hardware
MFRC522 rfid1(SS_1_PIN, RST_1_PIN);
MFRC522 rfid2(SS_2_PIN, RST_2_PIN);
MFRC522 rfid3(SS_3_PIN, RST_3_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);

WiFiClientSecure netClient;
PubSubClient mqtt(netClient);

// Status Timer Relay per Ruangan (Non-blocking)
unsigned long relay1OffAt = 0, relay2OffAt = 0, relay3OffAt = 0;
bool relay1Open = false, relay2Open = false, relay3Open = false;

unsigned long msgUntil = 0, lastFetch = 0, lastMqttTry = 0, lastFlush = 0, lastRfidCheck = 0, lastClockTick = 0;
bool needSync = false;

enum ValidationResult {
  RES_OK,
  RES_WRONG_ROOM,
  RES_NO_TIME,
  RES_NO_CACHE,
  RES_NO_UID,
  RES_NO_SCHEDULE
};

// ---------- LCD DISPLAY ----------
void lcdShow(const String& a, const String& b) {
  String x = a, y = b;
  while (x.length() < 16) x += ' ';
  while (y.length() < 16) y += ' ';
  lcd.setCursor(0, 0); lcd.print(x.substring(0, 16));
  lcd.setCursor(0, 1); lcd.print(y.substring(0, 16));
}

void showStandby() {
  if (WiFi.status() != WL_CONNECTED) {
    lcdShow("WiFi Offline", "Mode Lokal (1-3)");
  } else {
    lcdShow("Smart Room Acces", "Tap Kartu (1-3)");
  }
}

// ---------- WAKTU (NTP, WIB) ----------
bool timeValid() {
  struct tm t;
  if (!getLocalTime(&t, 10)) return false;
  return (t.tm_year + 1900) >= 2025;
}

void nowStrings(char* date, char* hm, char* iso, time_t* epoch) {
  time(epoch);
  struct tm t; localtime_r(epoch, &t);
  strftime(date, 11, "%Y-%m-%d", &t);
  strftime(hm, 6, "%H:%M", &t);
  strftime(iso, 20, "%Y-%m-%d %H:%M:%S", &t);
}

// ---------- CACHE SPIFFS ----------
bool cacheFresh() {
  File m = SPIFFS.open("/meta.txt", "r");
  if (!m) return false;
  long saved = m.readString().toInt();
  m.close();
  time_t now; time(&now);
  return saved > 0 && (now - saved) < CACHE_TTL_SEC;
}

// Ambil gabungan jadwal + daftar pemilik kartu dalam 1x HTTPS request (hemat RAM & stabilkan MQTT)
bool fetchAllData() {
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClientSecure syncClient;
  syncClient.setInsecure();
  HTTPClient http;
  http.begin(syncClient, API_SYNC);
  http.addHeader("x-api-key", API_KEY);
  http.setConnectTimeout(3000);
  http.setTimeout(3500);
  int code = http.GET();
  if (code != 200) {
    Serial.printf("[HTTP] Sync gagal, kode: %d\n", code);
    http.end();
    return false;
  }
  String body = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    Serial.println("[HTTP] JSON sync tidak valid");
    return false;
  }

  if (doc["schedules"].is<JsonArray>()) {
    File f = SPIFFS.open("/schedule.json", "w");
    if (f) {
      serializeJson(doc["schedules"], f);
      f.close();
    }
    if (timeValid()) {
      time_t now; time(&now);
      File m = SPIFFS.open("/meta.txt", "w");
      if (m) { m.print((long)now); m.close(); }
    }
  }

  if (doc["cards"].is<JsonArray>()) {
    File f = SPIFFS.open("/cards.json", "w");
    if (f) {
      serializeJson(doc["cards"], f);
      f.close();
    }
  }

  Serial.printf("[SPIFFS] Sync OK: %d jadwal, %d kartu terdaftar\n",
                doc["schedules"].size(), doc["cards"].size());
  return true;
}

// Cari nama pemilik kartu di /cards.json
String lookupCardName(const String& uid) {
  File f = SPIFFS.open("/cards.json", "r");
  if (!f) return "";
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return "";

  for (JsonObject c : doc.as<JsonArray>()) {
    if (String((const char*)c["uid"]).equalsIgnoreCase(uid)) {
      return String((const char*)c["name"]);
    }
  }
  return "";
}

// ---------- VALIDASI AKSES SESUAI JADWAL RUANGAN ----------
ValidationResult validate(const String& uid, const char* targetRoom, unsigned long* remainingMsOut = nullptr, String* ownerNameOut = nullptr, String* endTimeOut = nullptr) {
  if (!timeValid()) return RES_NO_TIME;
  if (!cacheFresh()) return RES_NO_CACHE;

  String knownName = lookupCardName(uid);
  bool uidFound = knownName.length() > 0;
  if (ownerNameOut != nullptr && uidFound) *ownerNameOut = knownName;

  File f = SPIFFS.open("/schedule.json", "r");
  if (!f) return RES_NO_CACHE;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return RES_NO_CACHE;

  char date[11], hm[6], iso[20]; time_t ep;
  nowStrings(date, hm, iso, &ep);

  bool hasActiveTime = false;

  for (JsonObject s : doc.as<JsonArray>()) {
    if (!String((const char*)s["uid"]).equalsIgnoreCase(uid)) continue;
    uidFound = true;
    if (ownerNameOut != nullptr && ownerNameOut->length() == 0 && s["name"].is<const char*>()) {
      *ownerNameOut = String((const char*)s["name"]);
    }

    // Periksa tanggal hari ini & status disetujui & jam aktif
    if (String((const char*)s["date"]) == date &&
        (bool)s["approved"] &&
        String((const char*)s["start"]) <= hm &&
        String(hm) <= String((const char*)s["end"])) {
      hasActiveTime = true;
      // Periksa apakah ruangan sesuai dengan reader yang di-tap
      if (String((const char*)s["roomId"]).equalsIgnoreCase(targetRoom)) {
        String endStr = String((const char*)s["end"]);
        if (endTimeOut != nullptr) *endTimeOut = endStr;
        if (remainingMsOut != nullptr) {
          struct tm ti;
          if (getLocalTime(&ti, 100)) {
            int nowSec = ti.tm_hour * 3600 + ti.tm_min * 60 + ti.tm_sec;
            int endH = endStr.substring(0, 2).toInt();
            int endM = endStr.substring(3, 5).toInt();
            int endSec = endH * 3600 + endM * 60;
            *remainingMsOut = (endSec > nowSec) ? (unsigned long)(endSec - nowSec) * 1000UL : OPEN_MS;
          } else {
            *remainingMsOut = OPEN_MS;
          }
        }
        return RES_OK;
      }
    }
  }

  if (hasActiveTime) return RES_WRONG_ROOM;
  return uidFound ? RES_NO_SCHEDULE : RES_NO_UID;
}

// ---------- PEMULIHAN LCD & 3 RFID DARI NOISE RELAY/SOLENOID ----------
void recoverPeripherals(bool reinitLcd = false) {
  if (reinitLcd) {
    lcd.init();
    lcd.backlight();
  }
  digitalWrite(SS_1_PIN, HIGH);
  digitalWrite(SS_2_PIN, HIGH);
  digitalWrite(SS_3_PIN, HIGH);
  rfid1.PCD_Init(); delay(10);
  rfid2.PCD_Init(); delay(10);
  rfid3.PCD_Init(); delay(10);
}

// ---------- AKTUATOR SOLENOID PER RUANGAN ----------
// durationMs = 0 berarti tetap terbuka sampai ada perintah 'lock'
void openDoor(int roomNumber, unsigned long durationMs = OPEN_MS) {
  unsigned long offAt = (durationMs == 0) ? 0 : (millis() + durationMs);
  if (roomNumber == 1) {
    digitalWrite(RELAY_1_PIN, RELAY_BUKA);
    relay1Open = true;
    relay1OffAt = offAt;
    Serial.printf("-> Solenoid Ruang MERAH (Relay 1) TERBUKA (%s)\n", durationMs == 0 ? "bebas/manual" : (String(durationMs / 1000) + "s").c_str());
  } else if (roomNumber == 2) {
    digitalWrite(RELAY_2_PIN, RELAY_BUKA);
    relay2Open = true;
    relay2OffAt = offAt;
    Serial.printf("-> Solenoid Ruang KUNING (Relay 2) TERBUKA (%s)\n", durationMs == 0 ? "bebas/manual" : (String(durationMs / 1000) + "s").c_str());
  } else if (roomNumber == 3) {
    digitalWrite(RELAY_3_PIN, RELAY_BUKA);
    relay3Open = true;
    relay3OffAt = offAt;
    Serial.printf("-> Solenoid Ruang HIJAU (Relay 3) TERBUKA (%s)\n", durationMs == 0 ? "bebas/manual" : (String(durationMs / 1000) + "s").c_str());
  }
  delay(80);
  recoverPeripherals(true);
}

void closeDoor(int roomNumber) {
  if (roomNumber == 1) {
    digitalWrite(RELAY_1_PIN, RELAY_KUNCI);
    relay1Open = false;
    relay1OffAt = 0;
    Serial.println("-> Solenoid Ruang MERAH (Relay 1) DIKUNCI manual.");
  } else if (roomNumber == 2) {
    digitalWrite(RELAY_2_PIN, RELAY_KUNCI);
    relay2Open = false;
    relay2OffAt = 0;
    Serial.println("-> Solenoid Ruang KUNING (Relay 2) DIKUNCI manual.");
  } else if (roomNumber == 3) {
    digitalWrite(RELAY_3_PIN, RELAY_KUNCI);
    relay3Open = false;
    relay3OffAt = 0;
    Serial.println("-> Solenoid Ruang HIJAU (Relay 3) DIKUNCI manual.");
  }
  delay(80);
  recoverPeripherals(true);
}

// ---------- MQTT PUBLISH LOG & RECONNECT ----------
void publishLog(const char* roomCode, const String& uid, bool granted, const char* reason, const char* method = "rfid") {
  char date[11], hm[6], iso[20]; time_t ep;
  nowStrings(date, hm, iso, &ep);

  JsonDocument d;
  d["room"]   = roomCode;
  d["uid"]    = uid;
  d["status"] = granted ? "granted" : "denied";
  d["reason"] = reason;
  d["method"] = method;
  d["ts"]     = timeValid() ? iso : "";

  char buf[256];
  serializeJson(d, buf);

  char dynamicTopic[50];
  snprintf(dynamicTopic, sizeof(dynamicTopic), "room/%s/access-log", roomCode);
  for (char* p = dynamicTopic; *p; p++) *p = tolower(*p);

  if (!(mqtt.connected() && mqtt.publish(dynamicTopic, buf))) {
    File f = SPIFFS.open("/pending.log", "a");
    if (f) { f.println(buf); f.close(); }
    Serial.println("[MQTT] Offline, log disimpan di antrean SPIFFS");
  }
}

void flushPending() {
  if (!mqtt.connected() || !SPIFFS.exists("/pending.log")) return;
  File f = SPIFFS.open("/pending.log", "r");
  if (!f) return;
  String keep; bool failed = false; int sent = 0;
  while (f.available()) {
    String line = f.readStringUntil('\n'); line.trim();
    if (!line.length()) continue;
    if (!failed && sent < 5 && mqtt.publish("room/merah/access-log", line.c_str())) sent++;
    else { failed = true; keep += line + "\n"; }
  }
  f.close();
  if (keep.length()) { File w = SPIFFS.open("/pending.log", "w"); w.print(keep); w.close(); }
  else SPIFFS.remove("/pending.log");
}

void mqttReconnect() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (millis() - lastMqttTry < 5000) return;
  lastMqttTry = millis();

  String cid = "esp32-controller-3room";
  if (mqtt.connect(cid.c_str(), MQTT_USER, MQTT_PASS, "room/merah/status", 1, true, "offline")) {
    // Publikasikan status online untuk ketiga ruangan sekaligus!
    mqtt.publish("room/merah/status", "online", true);
    mqtt.publish("room/kuning/status", "online", true);
    mqtt.publish("room/hijau/status", "online", true);

    // Dengarkan perintah buka pintu jarak jauh & trigger sync real-time dari backend
    mqtt.subscribe("room/+/command", 1);
    mqtt.subscribe("room/sync", 0);
    Serial.println("[MQTT] Terhubung! Status Online 3 Ruangan & subscribe command + sync");
  }
}

// Perintah Remote Unlock / Lock & Trigger Sync dari Web Dashboard
void onMqttMessage(char* topic, byte* payload, unsigned int len) {
  String m;
  for (unsigned int i = 0; i < len; i++) m += (char)payload[i];
  m.trim();

  String t = String(topic);
  if (t == "room/sync") {
    needSync = true;
    return;
  }
  int firstSlash = t.indexOf('/');
  int secondSlash = t.indexOf('/', firstSlash + 1);
  String r = "MERAH";
  if (firstSlash >= 0 && secondSlash > firstSlash) {
    r = t.substring(firstSlash + 1, secondSlash);
    r.toUpperCase();
  }

  int rNum = 1;
  if (r == "KUNING") rNum = 2;
  else if (r == "HIJAU") rNum = 3;

  if (m == "unlock") {
    openDoor(rNum, 0); // Bebas terbuka sampai admin mengunci
    lcdShow("Remote Unlock", "Ruang " + r);
    msgUntil = millis() + 2500;
    Serial.printf("[RELAY STATE] M=%d K=%d H=%d\n", relay1Open, relay2Open, relay3Open);
  } else if (m == "lock") {
    closeDoor(rNum);
    lcdShow("Remote Lock", "Ruang " + r);
    msgUntil = millis() + 2500;
    Serial.printf("[RELAY STATE] M=%d K=%d H=%d\n", relay1Open, relay2Open, relay3Open);
  }
}

// ---------- PEMROSESAN TAP KARTU RFID ----------
void handleCard(int roomNumber, const char* roomCode, const String& uid) {
  Serial.printf("\n[RFID %d - %s] Kartu Terdeteksi! UID: %s\n", roomNumber, roomCode, uid.c_str());
  lcdShow(String("Tap: ") + roomCode, "Memvalidasi...");
  unsigned long remainingMs = OPEN_MS;
  String ownerName = "";
  String endTimeStr = "";
  ValidationResult r = validate(uid, roomCode, &remainingMs, &ownerName, &endTimeStr);

  String displayName = ownerName.length() > 0 ? ownerName : uid;

  switch (r) {
    case RES_OK: {
      openDoor(roomNumber, remainingMs);
      String rTag = String(roomCode);
      String topLine = "OK " + rTag + (rTag.length() < 6 ? " " : "") + "->" + (endTimeStr.length() ? endTimeStr : "OPEN");
      lcdShow(topLine, displayName);
      publishLog(roomCode, uid, true, "OK", "rfid");
      break;
    }
    case RES_WRONG_ROOM:
      lcdShow(displayName, "Ditolak:S.Ruang!");
      publishLog(roomCode, uid, false, "WRONG_ROOM", "rfid");
      break;
    case RES_NO_UID:
      lcdShow("KARTU TDK KENAL", uid);
      publishLog(roomCode, uid, false, "UID_UNKNOWN", "rfid");
      break;
    case RES_NO_SCHEDULE:
      lcdShow(displayName, "Ditolak:NoJadwal");
      publishLog(roomCode, uid, false, "SCHEDULE_MISMATCH", "rfid");
      break;
    case RES_NO_TIME:
      lcdShow("WAKTU TDK VALID", "Akses Ditolak");
      publishLog(roomCode, uid, false, "TIME_INVALID", "rfid");
      break;
    case RES_NO_CACHE:
      lcdShow("DATA JADWAL", "Tidak Tersedia");
      publishLog(roomCode, uid, false, "NO_CACHE", "rfid");
      break;
  }
  msgUntil = millis() + 2500;
}

String readUid(MFRC522& reader) {
  String s = "";
  for (byte i = 0; i < reader.uid.size; i++) {
    if (i) s += ':';
    if (reader.uid.uidByte[i] < 0x10) s += '0';
    s += String(reader.uid.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

// ==========================================
// SETUP & LOOP
// ==========================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n[BOOT] ESP32 Smart Room Access START");

  // 1. Inisialisasi Ketiga Pin Relay Solenoid (terkunci di awal)
  pinMode(RELAY_1_PIN, OUTPUT); digitalWrite(RELAY_1_PIN, RELAY_KUNCI);
  pinMode(RELAY_2_PIN, OUTPUT); digitalWrite(RELAY_2_PIN, RELAY_KUNCI);
  pinMode(RELAY_3_PIN, OUTPUT); digitalWrite(RELAY_3_PIN, RELAY_KUNCI);

  // 2. Nonaktifkan sementara jalur SS RFID sebelum SPI aktif
  pinMode(SS_1_PIN, OUTPUT); digitalWrite(SS_1_PIN, HIGH);
  pinMode(SS_2_PIN, OUTPUT); digitalWrite(SS_2_PIN, HIGH);
  pinMode(SS_3_PIN, OUTPUT); digitalWrite(SS_3_PIN, HIGH);

  // 3. Inisialisasi LCD 16x2 I2C
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setTimeOut(50);
  lcd.init();
  lcd.backlight();
  lcdShow("Smart Room Acces", "Init 3 RFID...");

  // 4. Inisialisasi Bus SPI & Ketiga Reader RFID
  SPI.begin(18, 19, 23);
  rfid1.PCD_Init(); delay(50);
  rfid2.PCD_Init(); delay(50);
  rfid3.PCD_Init(); delay(50);

  Serial.printf("[RFID 1] Version: 0x%02X\n", rfid1.PCD_ReadRegister(MFRC522::VersionReg));
  Serial.printf("[RFID 2] Version: 0x%02X\n", rfid2.PCD_ReadRegister(MFRC522::VersionReg));
  Serial.printf("[RFID 3] Version: 0x%02X\n", rfid3.PCD_ReadRegister(MFRC522::VersionReg));

  SPIFFS.begin(true);

  // 5. Koneksi Wi-Fi menggunakan WiFiManager (bisa ganti Wi-Fi dari HP di lokasi Expo)
  lcdShow("Setup WiFi...", "AP:SmartRoomExpo");
  WiFiManager wm;
  wm.resetSettings(); // Hapus Wi-Fi tersimpan (hapus baris ini setelah selesai setup Wi-Fi baru)
  wm.setConfigPortalTimeout(180); // batas waktu portal 3 menit
  if (!wm.autoConnect("SmartRoom-Expo-Setup", "12345678")) {
    Serial.println("[WiFi] Gagal konek / timeout, lanjut Mode Lokal (SPIFFS)");
  } else {
    Serial.print("[WiFi] Terhubung! IP: ");
    Serial.println(WiFi.localIP());
  }

  // 6. Sinkronisasi Waktu NTP (WIB UTC+7) & TLS EMQX Cloud
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
  netClient.setInsecure(); // Izinkan TLS port 8883 ke EMQX Cloud
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(60);     // Cegah putus MQTT saat HTTPS sync
  mqtt.setSocketTimeout(5);
  mqtt.setCallback(onMqttMessage);

  if (WiFi.status() == WL_CONNECTED) {
    unsigned long t1 = millis();
    while (!timeValid() && millis() - t1 < 8000) delay(200);
    fetchAllData();
  }
  lastFetch = millis();
  showStandby();
  Serial.println("[SISTEM] Siap! 3 RFID & 3 Relay Solenoid aktif.");
}

void loop() {
  mqttReconnect();
  mqtt.loop();

  // Penguncian Otomatis Non-Blocking sesuai jadwal (jika relayOffAt > 0)
  if (relay1Open && relay1OffAt > 0 && millis() >= relay1OffAt) {
    digitalWrite(RELAY_1_PIN, RELAY_KUNCI);
    relay1Open = false;
    Serial.println("-> Relay 1 (MERAH) terkunci kembali.");
    if (mqtt.connected()) mqtt.publish("room/merah/door-state", "locked");
    delay(80);
    recoverPeripherals(true);
    if (!msgUntil) showStandby();
  }
  if (relay2Open && relay2OffAt > 0 && millis() >= relay2OffAt) {
    digitalWrite(RELAY_2_PIN, RELAY_KUNCI);
    relay2Open = false;
    Serial.println("-> Relay 2 (KUNING) terkunci kembali.");
    if (mqtt.connected()) mqtt.publish("room/kuning/door-state", "locked");
    delay(80);
    recoverPeripherals(true);
    if (!msgUntil) showStandby();
  }
  if (relay3Open && relay3OffAt > 0 && millis() >= relay3OffAt) {
    digitalWrite(RELAY_3_PIN, RELAY_KUNCI);
    relay3Open = false;
    Serial.println("-> Relay 3 (HIJAU) terkunci kembali.");
    if (mqtt.connected()) mqtt.publish("room/hijau/door-state", "locked");
    delay(80);
    recoverPeripherals(true);
    if (!msgUntil) showStandby();
  }

  // Kirim log tertunda saat offline
  if (millis() - lastFlush >= 30000) {
    lastFlush = millis();
    flushPending();
  }

  // Sync cepat jika ada update dari dashboard (via MQTT room/sync) atau backup tiap 3 menit
  if (needSync || (millis() - lastFetch >= FETCH_INTERVAL)) {
    needSync = false;
    lastFetch = millis();
    fetchAllData();
  }

  // Perbarui jam WIB & status ruangan di LCD standby tiap 30 detik
  if (!msgUntil && millis() - lastClockTick >= 30000) {
    lastClockTick = millis();
    showStandby();
  }

  // Jaga kesehatan 3 reader MFRC522 tiap 10 detik (auto-recover jika bus SPI hang/noise)
  if (!msgUntil && millis() - lastRfidCheck >= 10000) {
    lastRfidCheck = millis();
    auto recoverRfid = [](MFRC522& r, byte ss1, byte ss2) {
      digitalWrite(ss1, HIGH);
      digitalWrite(ss2, HIGH);
      byte v = r.PCD_ReadRegister(MFRC522::VersionReg);
      if (v == 0x00 || v == 0xFF) {
        r.PCD_Init();
      }
    };
    recoverRfid(rfid1, SS_2_PIN, SS_3_PIN);
    recoverRfid(rfid2, SS_1_PIN, SS_3_PIN);
    recoverRfid(rfid3, SS_1_PIN, SS_2_PIN);
  }

  // Kembali ke tampilan standby
  if (msgUntil && millis() >= msgUntil) {
    msgUntil = 0;
    showStandby();
  }

  // Deteksi Tap RFID pada masing-masing reader
  if (!msgUntil) {
    // ---- 1. Cek RFID 1 (Ruang Merah) ----
    digitalWrite(SS_2_PIN, HIGH);
    digitalWrite(SS_3_PIN, HIGH);
    if (rfid1.PICC_IsNewCardPresent() && rfid1.PICC_ReadCardSerial()) {
      String uid1 = readUid(rfid1);
      handleCard(1, "MERAH", uid1);
      rfid1.PICC_HaltA();
      rfid1.PCD_StopCrypto1();
    }
    digitalWrite(SS_1_PIN, HIGH);

    // ---- 2. Cek RFID 2 (Ruang Kuning) ----
    digitalWrite(SS_1_PIN, HIGH);
    digitalWrite(SS_3_PIN, HIGH);
    if (rfid2.PICC_IsNewCardPresent() && rfid2.PICC_ReadCardSerial()) {
      String uid2 = readUid(rfid2);
      handleCard(2, "KUNING", uid2);
      rfid2.PICC_HaltA();
      rfid2.PCD_StopCrypto1();
    }
    digitalWrite(SS_2_PIN, HIGH);

    // ---- 3. Cek RFID 3 (Ruang Hijau) ----
    digitalWrite(SS_1_PIN, HIGH);
    digitalWrite(SS_2_PIN, HIGH);
    if (rfid3.PICC_IsNewCardPresent() && rfid3.PICC_ReadCardSerial()) {
      String uid3 = readUid(rfid3);
      handleCard(3, "HIJAU", uid3);
      rfid3.PICC_HaltA();
      rfid3.PCD_StopCrypto1();
    }
    digitalWrite(SS_3_PIN, HIGH);
  }
  delay(20); // Beri jeda agar bus SPI MFRC522 tidak overload/hang
}
