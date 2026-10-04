/*
 * ======================================================================================
 * SMART FIRE GUARD - ESP32 IOT HARDWARE CODE
 * Hệ Thống Báo Cháy Thông Minh Kết Nối Node.js Server
 * ======================================================================================
 * Linh kiện:
 * 1. ESP32 Dev Module
 * 2. Cảm biến Nhiệt độ / Độ ẩm: DHT11 hoặc DHT22 (Chân D4 / GPIO4)
 * 3. Cảm biến Khói / Gas: MQ-2 (Chân A0 / GPIO34 Analog)
 * 4. Cảm biến Lửa: Flame Sensor Module (Chân D18 / GPIO18 Digital)
 * 5. Còi báo động (Buzzer): Active Buzzer (Chân D23 / GPIO23)
 * 6. Đèn LED Cảnh báo: LED Đỏ / Xanh (Chân D2 / GPIO2)
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "DHT.h"

// --------------------------------------------------------------------------------------
// CAU HINH WIFI VA NODEJS SERVER
// --------------------------------------------------------------------------------------
const char* WIFI_SSID     = "YOUR_WIFI_NAME";        // Tên WiFi nhà / phòng lab của bạn
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";    // Mật khẩu WiFi
const char* SERVER_URL    = "http://192.168.1.100:3000/api/sensor-data"; // Thay bằng IP máy chạy Node.js

// --------------------------------------------------------------------------------------
// CAU HINH CHAN LINH KIEN (PIN MAP)
// --------------------------------------------------------------------------------------
#define DHTPIN 4           // Chân cắm cảm biến DHT
#define DHTTYPE DHT11      // DHT 11 hoặc DHT22
#define MQ2_ANALOG_PIN 34  // Chân đọc khói/gas Analog (GPIO34)
#define FLAME_PIN 18       // Chân đọc cảm biến lửa Digital (GPIO18)
#define BUZZER_PIN 23      // Chân phát còi (GPIO23)
#define LED_PIN 2          // Chân đèn LED trạng thái (GPIO2)

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n--- DANG KHONG CHUYEN DANG BIEU ESP32 SMART FIRE GUARD ---");

  pinMode(MQ2_ANALOG_PIN, INPUT);
  pinMode(FLAME_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);

  dht.begin();

  // Kết nối WiFi
  Serial.print("Dang ket noi WiFi: ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Nhấp nháy LED khi chờ kết nối
  }

  digitalWrite(LED_PIN, HIGH);
  Serial.println("\n[OK] WiFi da ket noi thanh cong!");
  Serial.print("Dia chi IP ESP32: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    // 1. Đọc dữ liệu từ cảm biến
    float temp = dht.readTemperature();
    if (isnan(temp)) temp = 30.0; // Fallback nếu lỗi cảm biến DHT

    int mq2Raw = analogRead(MQ2_ANALOG_PIN); // Giá trị từ 0 -> 4095
    float smokePercent = map(mq2Raw, 0, 4095, 0, 100);
    float gasPercent   = smokePercent * 0.8;

    int flameState = digitalRead(FLAME_PIN); 
    // Thường cảm biến lửa xuất mức LOW (0) khi phát hiện lửa, HIGH (1) khi bình thường
    bool isFlameDetected = (flameState == LOW);

    Serial.printf("[SENSOR] Temp: %.1fC | Smoke: %.0f%% | Gas: %.0f%% | Flame: %s\n",
                  temp, smokePercent, gasPercent, isFlameDetected ? "FIRE!" : "Normal");

    // 2. Tạo JSON gửi lên Node.js Server
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");

    StaticJsonDocument<200> doc;
    doc["temperature"] = temp;
    doc["smoke"]       = smokePercent;
    doc["gas"]         = gasPercent;
    doc["flame"]       = isFlameDetected ? 1 : 0;

    String jsonOutput;
    serializeJson(doc, jsonOutput);

    // 3. Gửi HTTP POST request
    int httpResponseCode = http.POST(jsonOutput);

    if (httpResponseCode > 0) {
      String response = http.getString();
      Serial.printf("[HTTP %d] Phan hoi tu Node.js: %s\n", httpResponseCode, response.c_str());

      // Giải mã phản hồi từ Node.js server để bật còi báo động tại chỗ
      StaticJsonDocument<300> respDoc;
      DeserializationError err = deserializeJson(respDoc, response);

      if (!err) {
        bool alarmActive = respDoc["alarmActive"] | false;
        if (alarmActive) {
          // Bật còi báo động cục bộ tại ESP32
          digitalWrite(BUZZER_PIN, HIGH);
          digitalWrite(LED_PIN, (millis() / 250) % 2); // Nhấp nháy LED đỏ cấp bách
        } else {
          digitalWrite(BUZZER_PIN, LOW);
          digitalWrite(LED_PIN, HIGH);
        }
      }
    } else {
      Serial.printf("[ERR] HTTP POST loi: %s\n", http.errorToString(httpResponseCode).c_str());
    }

    http.end();
  } else {
    Serial.println("[WARN] WiFi mat ket noi, dang thu ket noi lai...");
    WiFi.reconnect();
  }

  delay(1500); // Gửi dữ liệu định kỳ mỗi 1.5 giây
}
