/*
 * Smart Fire Guard - classic ESP32 DevKit / WROOM-32, 38 pins, CP2102.
 * Arduino IDE: ESP32 Dev Module. Serial Monitor: 115200 baud.
 * Wiring and limitations: ../README.md. Private credentials: secrets.h.
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <math.h>
#include <string.h>
#include "secrets.h"

#if ARDUINOJSON_VERSION_MAJOR >= 7
using RequestDocument = JsonDocument;
using ResponseDocument = JsonDocument;
#else
using RequestDocument = StaticJsonDocument<512>;
using ResponseDocument = StaticJsonDocument<1024>;
#endif

constexpr uint8_t DHT_PIN = 4;
constexpr uint8_t MQ2_PIN = 34;    // ADC1: usable while Wi-Fi is enabled.
constexpr uint8_t FLAME_PIN = 18;
constexpr uint8_t BUZZER_PIN = 23; // Active-high buzzer/driver input.
constexpr uint8_t LED_PIN = 2;     // Active-high LED, with series resistor.
#define DHT_TYPE DHT22           // Change to DHT22 only if that is your sensor.

constexpr uint32_t SAMPLE_INTERVAL_MS = 2500;
constexpr uint32_t WIFI_RETRY_MS = 10000;
// Local fallback uses the backend's DEFAULT danger thresholds (strict >).
// These prototype values are NOT synchronized with dashboard threshold edits.
constexpr float LOCAL_TEMP_DANGER_C = 60.0f;
constexpr float LOCAL_MQ2_DANGER_PERCENT = 60.0f;

DHT dht(DHT_PIN, DHT_TYPE);
bool alarmLatched = false;
bool temperatureFault = true;
bool backendReachable = false;
bool wifiWasConnected = false;
bool wifiConfigured = false;
bool deviceTokenConfigured = false;
uint32_t lastSampleMs = 0;
uint32_t lastWifiRetryMs = 0;

struct Reading {
  float temperature;
  int mq2Raw;
  float mq2Relative;
  bool flame;
  bool temperatureOk;
};

// Explicit declarations avoid Arduino auto-prototypes preceding this struct.
bool localDanger(const Reading& reading);
Reading readSensors();
void sendReading(const Reading& reading);

bool localDanger(const Reading& reading) {
  return reading.flame || reading.mq2Relative > LOCAL_MQ2_DANGER_PERCENT ||
         (reading.temperatureOk && reading.temperature > LOCAL_TEMP_DANGER_C);
}

void updateOutputs() {
  digitalWrite(BUZZER_PIN, alarmLatched ? HIGH : LOW);
  if (alarmLatched) {
    digitalWrite(LED_PIN, (millis() / 250) % 2 ? HIGH : LOW);
  } else if (temperatureFault || !backendReachable || WiFi.status() != WL_CONNECTED) {
    digitalWrite(LED_PIN, (millis() / 750) % 2 ? HIGH : LOW);
  } else {
    digitalWrite(LED_PIN, HIGH);
  }
}

void maintainWifi(uint32_t now) {
  wl_status_t status = WiFi.status();
  bool connected = (status == WL_CONNECTED);

  if (connected && !wifiWasConnected) {
    Serial.println("[WIFI] CONNECTED!");
    Serial.print("[WIFI] ESP32 IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WIFI] Signal RSSI: ");
    Serial.println(WiFi.RSSI());
  }

  if (!connected && wifiWasConnected) {
    Serial.println("[WIFI] Connection lost!");
    backendReachable = false;
  }

  wifiWasConnected = connected;

  if (!wifiConfigured || connected) {
    return;
  }

  // Tránh gọi reconnect khi ESP32 đang trong quá trình kết nối.
  // Mỗi 20 giây thử khởi động lại quá trình kết nối.
  if (now - lastWifiRetryMs >= 20000) {
    lastWifiRetryMs = now;

    Serial.printf(
      "[WIFI] Connection timeout. Status: %d\n",
      (int)status
    );

    WiFi.disconnect(false, false);
    delay(200);

    Serial.println("[WIFI] Starting new connection...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

Reading readSensors() {
  Reading reading;
  reading.temperature = dht.readTemperature();
  reading.temperatureOk =
    isfinite(reading.temperature) &&
    reading.temperature >= -40.0f &&
    reading.temperature <= 80.0f;
  reading.mq2Raw = analogRead(MQ2_PIN);
  reading.mq2Relative = reading.mq2Raw * (100.0f / 4095.0f);
  reading.flame = digitalRead(FLAME_PIN) == LOW;
  temperatureFault = !reading.temperatureOk;
  if (reading.temperatureOk) {
    Serial.printf("[SENSOR] Temperature: %.1f C\n", reading.temperature);
  } else {
    Serial.println("[SENSOR] DHT FAULT: sending temperature=null, not a substitute value.");
  }
  Serial.printf("[SENSOR] MQ2 ADC: %d | Relative: %.1f%% (not ppm) | Flame: %s\n",
                reading.mq2Raw, reading.mq2Relative, reading.flame ? "DETECTED" : "no");
  return reading;
}

void sendReading(const Reading& reading) {
  if (WiFi.status() != WL_CONNECTED || !deviceTokenConfigured) {
    backendReachable = false;
    return;
  }
  WiFiClient client;
  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(2000);
  if (!http.begin(client, SERVER_URL)) {
    backendReachable = false;
    Serial.println("[HTTP] Cannot open SERVER_URL. Check secrets.h.");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);

  RequestDocument payload;
  if (reading.temperatureOk) {
    payload["temperature"] = reading.temperature;
  } else {
    payload["temperature"] = nullptr;
    payload["health"]["temperature"] = "fault";
  }
  // One MQ2 analog signal supplies both legacy API channels. These are the
  // SAME uncalibrated relative reading, not independent measurements or ppm.
  payload["smoke"] = reading.mq2Relative;
  payload["gas"] = reading.mq2Relative;
  payload["flame"] = reading.flame;
  String body;
  serializeJson(payload, body);
  const int code = http.POST(body);
  backendReachable = false;
  if (code <= 0) {
    Serial.printf("[HTTP] Connection failed: %s. Check server/IP/firewall.\n",
                  http.errorToString(code).c_str());
  } else if (code < 200 || code >= 300) {
    Serial.printf("[HTTP %d] Rejected; alarm output is held.\n", code);
    if (code == 401 || code == 403) {
      Serial.println("[AUTH] Check DEVICE_TOKEN and device enabled status on backend.");
    } else {
      Serial.println(http.getString());
    }
  } else {
    const String response = http.getString();
    ResponseDocument result;
    const DeserializationError error = deserializeJson(result, response);
    if (error || !result["success"].is<bool>() || !result["success"].as<bool>()) {
      Serial.printf("[HTTP %d] Invalid response; alarm output is held.\n", code);
    } else {
      backendReachable = true;
      if (result["alarmActive"].is<bool>()) {
        const bool remoteAlarm = result["alarmActive"].as<bool>();
        if (remoteAlarm || localDanger(reading)) {
          alarmLatched = true;
        } else if (reading.temperatureOk) {
          // Only a successful server response and healthy local sample may
          // clear an alarm. Unknown/null, faults and HTTP failures never do.
          alarmLatched = false;
        }
        Serial.printf("[HTTP %d] Data accepted | Server alarm: %s | Buzzer: %s\n",
                      code, remoteAlarm ? "ON" : "OFF", alarmLatched ? "ON" : "OFF");
      } else {
        Serial.printf("[HTTP %d] Data accepted | State UNKNOWN; alarm is held.\n", code);
      }
    }
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(MQ2_PIN, INPUT);
  pinMode(FLAME_PIN, INPUT_PULLUP); // Module is assumed active-low.
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);
  analogReadResolution(12);
  dht.begin();

  Serial.println("\n--- SMART FIRE GUARD | ESP32 38-PIN / CP2102 ---");
  Serial.println("[PINS] DHT=4 MQ2_AO=34 FLAME_DO=18 BUZZER=23 LED=2");
  Serial.print("[SERVER] ");
  Serial.println(SERVER_URL);
  Serial.println("[MQ2] Smoke/gas share one relative ADC reading; not calibrated ppm.");
  deviceTokenConfigured = strlen(DEVICE_TOKEN) == 43;
  if (!deviceTokenConfigured) {
    Serial.println("[CONFIG] Set a real DEVICE_TOKEN in secrets.h. Local sensing stays active.");
  }
  wifiConfigured = strlen(WIFI_SSID) > 0 && strcmp(WIFI_SSID, "YOUR_WIFI_SSID") != 0 &&
                   strcmp(WIFI_PASSWORD, "YOUR_WIFI_PASSWORD") != 0;
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  Serial.print("[WIFI] SSID: ");
Serial.println(WIFI_SSID);

Serial.print("[WIFI] MAC: ");
Serial.println(WiFi.macAddress());

Serial.println("[WIFI] Scanning networks...");

int networks = WiFi.scanNetworks();

for (int i = 0; i < networks; i++) {
  Serial.printf(
    "[SCAN] %s | RSSI: %d | Channel: %d\n",
    WiFi.SSID(i).c_str(),
    WiFi.RSSI(i),
    WiFi.channel(i)
  );
}

WiFi.scanDelete();
  if (wifiConfigured) {
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.println("[WIFI] Connecting without blocking local sensing...");
  } else {
    Serial.println("[CONFIG] Set Wi-Fi credentials in secrets.h.");
  }
  lastWifiRetryMs = millis();
}

void loop() {
  const uint32_t now = millis();
  maintainWifi(now);
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    const Reading reading = readSensors();
    if (localDanger(reading)) alarmLatched = true;
    updateOutputs(); // Apply local danger BEFORE any network operation.
    sendReading(reading);
  }
  updateOutputs();
  delay(10);
}
