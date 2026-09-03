/* =====================================================================
   Sahakar Sathi — ESP32-C3 Voice Terminal
   Push-to-talk hardware client for cglachatbot.netlify.app

   Board:            ESP32C3 Dev Module
   USB CDC On Boot:  Enabled
   Serial:           115200

   Hardware (already wired and tested per project notes):
     TTP223 touch sensor : VCC->3.3V, GND->GND, OUT->GPIO3 (HIGH=touched)
     INMP441 mic (I2S RX): VDD->3.3V, GND->GND, L/R->GND,
                            SCK->GPIO4, WS->GPIO5, SD->GPIO6
     MAX98357A amp (I2S TX): VIN->5V/VBUS, GND->GND,
                            BCLK->GPIO4, LRC->GPIO5, DIN->GPIO7
     Speaker: SPK+/SPK- -> speaker terminals

   GPIO4 (BCLK/SCK) and GPIO5 (LRC/WS) are intentionally shared between
   the mic and the amp — this firmware is push-to-talk (record, THEN
   play), never both at once, so the I2S peripheral is torn down and
   reconfigured between RX and TX rather than running two ports.

   Flow implemented:
     IDLE -> touch -> RECORDING (streamed to LittleFS, not RAM)
     -> release -> STOP -> WAV header patched -> UPLOADING
     -> voice-upload (device_key + WAV) -> transcript (server-side,
        broadcast to the browser over Realtime — this firmware does not
        see the transcript) -> POLLING voice-fetch for the TTS reply
     -> PLAYING (streamed from LittleFS through I2S TX) -> IDLE

   A new touch while BUSY (anything other than IDLE) is ignored — see
   the state machine below. This is deliberate: half-duplex push-to-talk
   only, per the project's explicit constraint against full-duplex.

   WiFi provisioning (untouched behavior, per project constraint):
     AP:       VoiceButton-Setup / voice1234, served at 192.168.4.1
     Storage:  Preferences namespace "wifi", keys "ssid" / "password"
     No WiFi.scanNetworks() — manual SSID entry + two named quick options
     (MARINE EDGE / MARINE_EDGE) + a free-text custom option.
   ===================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <driver/i2s.h>

// ============================================================
// ---- CONFIG: fill in / confirm before flashing ----
// ============================================================

// Same prototype device key already used by trigger-mic in this project.
// Prototype-only, per the project's own risk notes — rotate before any
// production use. Kept here, not in a separate header, so there is
// exactly one place in this firmware to look for it.
static const char *DEVICE_API_KEY = "92cc102c60dca20b778c31ea4fb85ae7962d83a14631803b3aaf3fe0bee40153";

static const char *VOICE_UPLOAD_URL =
    "https://njpxixfcctodjejtgmwj.supabase.co/functions/v1/voice-upload";
static const char *VOICE_FETCH_URL =
    "https://njpxixfcctodjejtgmwj.supabase.co/functions/v1/voice-fetch";

// BCP-47 code forwarded to Sarvam by voice-upload — change if the demo
// account's language differs from English.
static const char *UPLOAD_LANG = "en-IN";

// ============================================================
// ---- Pins ----
// ============================================================

#define PIN_TOUCH   3
#define PIN_I2S_BCLK 4   // shared: INMP441 SCK / MAX98357A BCLK
#define PIN_I2S_WS   5   // shared: INMP441 WS   / MAX98357A LRC
#define PIN_I2S_SD_IN  6 // INMP441 SD  (mic data in)
#define PIN_I2S_SD_OUT 7 // MAX98357A DIN (amp data out)

// ============================================================
// ---- Audio format (matches the already-validated mic test) ----
// ============================================================

#define SAMPLE_RATE      16000
#define BITS_PER_SAMPLE  16     // output PCM width after >>16 conversion
#define I2S_READ_BITS    32     // INMP441 delivers 32-bit frames
#define NUM_CHANNELS     1      // mono

static const char *RECORDING_PATH = "/recording.wav";
static const char *RESPONSE_PATH  = "/response.mp3";

// Safety cap so a stuck touch can't fill the filesystem — 30s at
// 16kHz/16-bit/mono is ~960KB, comfortably inside typical LittleFS
// partitions on an ESP32-C3, but this cap exists so a firmware bug
// (e.g. release never detected) fails safe instead of filling flash.
#define MAX_RECORD_SECONDS 30
#define MAX_RECORD_BYTES (SAMPLE_RATE * 2UL * MAX_RECORD_SECONDS)

// Touch timing
#define TOUCH_DEBOUNCE_MS   40
#define AUTOSTOP_ELIGIBLE_MS 300  // matches the project's "~300-350ms" note — not currently used to gate START itself (release-based push-to-talk starts immediately on debounce), kept as a named constant for clarity/tuning

// WiFi-setup gesture: 5 taps within 3 seconds (per project's later spec
// revision — NOT the older 5-second long-hold, which is intentionally
// removed so a long push-to-talk hold never falls into setup mode).
#define TAP_GESTURE_COUNT     5
#define TAP_GESTURE_WINDOW_MS 3000
#define TAP_MAX_DURATION_MS   400  // a "tap" must release quickly to count

// TTS polling
#define POLL_INTERVAL_MS 500
#define POLL_TIMEOUT_MS  30000

// ============================================================
// ---- State machine ----
// ============================================================

enum State {
  ST_IDLE,
  ST_RECORDING,
  ST_UPLOADING,
  ST_POLLING,
  ST_PLAYING,
  ST_SETUP_GESTURE   // mid-way through counting a possible 5-tap gesture
};

static State state = ST_IDLE;

static Preferences prefs;
static WebServer setupServer(80);
static bool apMode = false;

// Touch tracking
static bool lastTouchLevel = LOW;
static unsigned long lastTouchChangeMs = 0;
static unsigned long touchDownAtMs = 0;

// Tap-gesture tracking
static int tapCount = 0;
static unsigned long firstTapAtMs = 0;

// Recording state
static File recordingFile;
static uint32_t recordedBytes = 0;

// ============================================================
// ---- Forward declarations ----
// ============================================================

void loadWifiCredentials(String &ssid, String &password);
void saveWifiCredentials(const String &ssid, const String &password);
bool connectWifi(const String &ssid, const String &password, uint32_t timeoutMs);
void startSetupAP();
void handleSetupRoot();
void handleSetupSave();

void i2sConfigureRx();
void i2sConfigureTx();
void i2sTeardown();

void onTouchDown(unsigned long now);
void onTouchRelease(unsigned long now);

void beginRecording();
void abandonRecording();
void writePcmChunk();
void finalizeRecording();
void writeWavHeaderPlaceholder(File &f);
void patchWavHeader(File &f, uint32_t dataBytes);

bool uploadRecording();
bool pollAndPlayResponse();
void playMp3File(const String &path);

// ============================================================
// setup / loop
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Sahakar Sathi Voice Terminal booting ===");

  pinMode(PIN_TOUCH, INPUT);

  if (!LittleFS.begin(true)) {
    Serial.println("FATAL: LittleFS mount failed even after format — halting.");
    while (true) delay(1000);
  }

  prefs.begin("wifi", false);
  String ssid, password;
  loadWifiCredentials(ssid, password);

  if (ssid.length() > 0 && connectWifi(ssid, password, 15000)) {
    Serial.println("WiFi connected: " + WiFi.localIP().toString());
  } else {
    Serial.println("No saved WiFi, or connection failed — entering setup mode.");
    startSetupAP();
  }
}

void loop() {
  if (apMode) {
    setupServer.handleClient();
    return; // no recording/playback logic while in setup mode
  }

  bool level = digitalRead(PIN_TOUCH);
  unsigned long now = millis();

  // ---- debounce ----
  if (level != lastTouchLevel) {
    if (now - lastTouchChangeMs < TOUCH_DEBOUNCE_MS) {
      // bounce — ignore, don't update lastTouchChangeMs so a genuine
      // transition right after still gets its own debounce window
    } else {
      lastTouchChangeMs = now;
      lastTouchLevel = level;

      if (level == HIGH) {
        // ---- touch DOWN ----
        touchDownAtMs = now;
        onTouchDown(now);
      } else {
        // ---- touch UP / release ----
        onTouchRelease(now);
      }
    }
  }

  // Tap-gesture window expiry (no tap arrived in time -> reset)
  if (state == ST_SETUP_GESTURE && tapCount > 0 && (now - firstTapAtMs) > TAP_GESTURE_WINDOW_MS) {
    Serial.println("Tap gesture window expired — back to IDLE.");
    tapCount = 0;
    state = ST_IDLE;
  }

  // Safety cap during recording
  if (state == ST_RECORDING && recordedBytes >= MAX_RECORD_BYTES) {
    Serial.println("MAX_RECORD_SECONDS reached — forcing stop.");
    onTouchRelease(now);
  }

  if (state == ST_RECORDING) {
    writePcmChunk();
  }
}

// ============================================================
// Touch event handlers
// ============================================================

void onTouchDown(unsigned long now) {
  Serial.println("TOUCH DOWN");

  if (state == ST_IDLE || state == ST_SETUP_GESTURE) {
    // Could be the start of a genuine push-to-talk OR the next tap of an
    // in-progress 5-tap setup gesture — we don't know yet, so (re-)start
    // recording either way. If it turns out to be a quick tap (released
    // within TAP_MAX_DURATION_MS), the release handler discards the
    // recording and counts it as a tap instead. ST_SETUP_GESTURE must be
    // accepted here too, not just ST_IDLE — after tap 1 sets state to
    // ST_SETUP_GESTURE, taps 2-5 arrive in exactly that state, and
    // without this branch they would be silently ignored, breaking the
    // gesture after the first tap every time.
    if (tapCount == 0) firstTapAtMs = now;
    beginRecording();
  }
  // Any other state (UPLOADING/POLLING/PLAYING/RECORDING already) means
  // a new touch-down is ignored — PART 10's "reject a new recording
  // while busy" requirement, enforced here at the firmware level (the
  // backend has no way to know the ESP32 is mid-cycle).
}

void onTouchRelease(unsigned long now) {
  Serial.println("TOUCH UP / RELEASE");

  if (state != ST_RECORDING) return; // release with nothing active — ignore

  unsigned long heldMs = now - touchDownAtMs;

  if (heldMs <= TAP_MAX_DURATION_MS) {
    // ---- this was a TAP, not a push-to-talk hold ----
    abandonRecording();
    tapCount++;
    Serial.printf("Tap %d/%d registered.\n", tapCount, TAP_GESTURE_COUNT);

    if (tapCount >= TAP_GESTURE_COUNT) {
      Serial.println("5-tap gesture complete -> entering WiFi setup mode.");
      tapCount = 0;
      state = ST_IDLE;
      startSetupAP();
      return;
    }
    state = ST_SETUP_GESTURE; // waiting for the next tap or the window to expire
    return;
  }

  // ---- this was a genuine push-to-talk hold ----
  tapCount = 0; // a real hold cancels any in-progress tap sequence
  Serial.println("STOP RECORDING");
  finalizeRecording();

  state = ST_UPLOADING;
  bool uploaded = uploadRecording();

  if (!uploaded) {
    Serial.println("UPLOAD_ERROR — returning to IDLE.");
    state = ST_IDLE;
    return;
  }

  state = ST_POLLING;
  bool played = pollAndPlayResponse();
  if (!played) {
    Serial.println("No TTS response received within timeout (or playback failed) — IDLE.");
  }
  state = ST_IDLE;
  Serial.println("=== Cycle complete, back to IDLE ===\n");
}

// ============================================================
// I2S: RX (microphone) configuration
// ============================================================

void i2sConfigureRx() {
  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
      .sample_rate = SAMPLE_RATE,
      .bits_per_sample = (i2s_bits_per_sample_t)I2S_READ_BITS,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT, // INMP441 L/R tied to GND -> left slot, per validated test config
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 4,
      .dma_buf_len = 256,
      .use_apll = false,
      .tx_desc_auto_clear = false,
      .fixed_mclk = 0,
  };
  i2s_pin_config_t pins = {
      .bck_io_num = PIN_I2S_BCLK,
      .ws_io_num = PIN_I2S_WS,
      .data_out_num = I2S_PIN_NO_CHANGE,
      .data_in_num = PIN_I2S_SD_IN,
  };
  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
  i2s_zero_dma_buffer(I2S_NUM_0);
}

// ============================================================
// I2S: TX (amplifier) configuration
// ============================================================

void i2sConfigureTx() {
  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = SAMPLE_RATE,
      .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
      .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
      .communication_format = I2S_COMM_FORMAT_STAND_I2S,
      .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
      .dma_buf_count = 4,
      .dma_buf_len = 256,
      .use_apll = false,
      .tx_desc_auto_clear = true,
      .fixed_mclk = 0,
  };
  i2s_pin_config_t pins = {
      .bck_io_num = PIN_I2S_BCLK,
      .ws_io_num = PIN_I2S_WS,
      .data_out_num = PIN_I2S_SD_OUT,
      .data_in_num = I2S_PIN_NO_CHANGE,
  };
  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
}

void i2sTeardown() {
  i2s_driver_uninstall(I2S_NUM_0);
}

// ============================================================
// Recording: streamed to LittleFS (never buffered whole in RAM)
// ============================================================

void writeWavHeaderPlaceholder(File &f) {
  // Standard 44-byte canonical PCM WAV header. Sizes are placeholders
  // (0) here and patched once the true length is known, in
  // patchWavHeader() — this is exactly why the header is written first
  // and the file is opened for update rather than append-only.
  uint8_t header[44];
  uint32_t byteRate = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  uint16_t blockAlign = NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

  memcpy(header + 0, "RIFF", 4);
  uint32_t chunkSize = 0; // patched later
  memcpy(header + 4, &chunkSize, 4);
  memcpy(header + 8, "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  uint32_t subchunk1Size = 16;
  memcpy(header + 16, &subchunk1Size, 4);
  uint16_t audioFormat = 1; // PCM
  memcpy(header + 20, &audioFormat, 2);
  uint16_t numChannels = NUM_CHANNELS;
  memcpy(header + 22, &numChannels, 2);
  uint32_t sampleRate = SAMPLE_RATE;
  memcpy(header + 24, &sampleRate, 4);
  memcpy(header + 28, &byteRate, 4);
  memcpy(header + 32, &blockAlign, 2);
  uint16_t bitsPerSample = BITS_PER_SAMPLE;
  memcpy(header + 34, &bitsPerSample, 2);
  memcpy(header + 36, "data", 4);
  uint32_t subchunk2Size = 0; // patched later
  memcpy(header + 40, &subchunk2Size, 4);

  f.write(header, 44);
}

void patchWavHeader(File &f, uint32_t dataBytes) {
  uint32_t riffChunkSize = 36 + dataBytes;
  f.seek(4);
  f.write((uint8_t *)&riffChunkSize, 4);
  f.seek(40);
  f.write((uint8_t *)&dataBytes, 4);
  f.seek(44); // leave the cursor past the header for anything reading after
}

void beginRecording() {
  Serial.println("START RECORDING");

  if (LittleFS.exists(RECORDING_PATH)) LittleFS.remove(RECORDING_PATH);
  recordingFile = LittleFS.open(RECORDING_PATH, FILE_WRITE);
  if (!recordingFile) {
    Serial.println("ERROR: could not open recording file for write.");
    state = ST_IDLE;
    return;
  }
  writeWavHeaderPlaceholder(recordingFile);
  recordedBytes = 0;

  i2sConfigureRx();
  state = ST_RECORDING;
}

void abandonRecording() {
  // Used when a touch turns out to be a tap (part of the setup gesture),
  // not real push-to-talk speech — stop I2S and discard the file.
  i2sTeardown();
  if (recordingFile) recordingFile.close();
  if (LittleFS.exists(RECORDING_PATH)) LittleFS.remove(RECORDING_PATH);
  recordedBytes = 0;
}

void writePcmChunk() {
  static int32_t i2sBuf[256];
  size_t bytesRead = 0;
  esp_err_t err = i2s_read(I2S_NUM_0, (void *)i2sBuf, sizeof(i2sBuf), &bytesRead, 20 / portTICK_PERIOD_MS);
  if (err != ESP_OK || bytesRead == 0) return;

  int samples = bytesRead / sizeof(int32_t);
  static int16_t pcmBuf[256];
  int outCount = 0;

  for (int i = 0; i < samples && outCount < 256; i++) {
    // Validated conversion from the project's own mic test: the INMP441
    // delivers a 32-bit frame; the audible sample lives in the upper
    // bits, so a straight arithmetic right-shift by 16 recovers 16-bit PCM.
    int16_t pcm = (int16_t)(i2sBuf[i] >> 16);
    pcmBuf[outCount++] = pcm;
  }

  size_t outBytes = outCount * sizeof(int16_t);
  if (recordedBytes + outBytes > MAX_RECORD_BYTES) {
    outBytes = MAX_RECORD_BYTES - recordedBytes; // truncate to the cap exactly
  }
  if (outBytes == 0) return;

  recordingFile.write((uint8_t *)pcmBuf, outBytes);
  recordedBytes += outBytes;
}

void finalizeRecording() {
  i2sTeardown();
  patchWavHeader(recordingFile, recordedBytes);
  recordingFile.close();
  Serial.printf("Recording finalized: %u bytes PCM (%.2fs)\n",
                recordedBytes, recordedBytes / (float)(SAMPLE_RATE * 2));
}

// ============================================================
// Upload: multipart/form-data POST to voice-upload
// ============================================================

// Uses WiFiClientSecure directly rather than HTTPClient: HTTPClient's
// higher-level send() variants want the whole body as one String/buffer
// argument, which would mean holding the entire WAV in RAM — exactly what
// the streamed-to-LittleFS recording design above was meant to avoid. A
// few hundred KB of WAV is well within ESP32-C3 RAM in principle, but
// there is no reason to reintroduce a full-buffer requirement at the
// upload step when the request can be written directly to the socket in
// small chunks instead, matching the same streaming approach used for
// recording and playback.
bool uploadRecording() {
  Serial.println("UPLOADING");

  File f = LittleFS.open(RECORDING_PATH, FILE_READ);
  if (!f) {
    Serial.println("UPLOAD_ERROR: could not reopen recording file.");
    return false;
  }
  size_t fileSize = f.size();

  WiFiClientSecure client;
  // Prototype-only: skips TLS certificate validation. Isolated here and
  // clearly commented — replace with a pinned root CA before any
  // production deployment of this firmware.
  client.setInsecure();

  String boundary = "----ESP32VoiceBoundary7f3a9c";
  String head =
      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"device_key\"\r\n\r\n" +
      String(DEVICE_API_KEY) + "\r\n" +
      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"lang\"\r\n\r\n" +
      String(UPLOAD_LANG) + "\r\n" +
      "--" + boundary + "\r\n"
      "Content-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\n"
      "Content-Type: audio/wav\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";

  size_t totalLen = head.length() + fileSize + tail.length();

  if (!client.connect("njpxixfcctodjejtgmwj.supabase.co", 443)) {
    Serial.println("UPLOAD_ERROR: TLS connect failed.");
    f.close();
    return false;
  }

  client.println("POST /functions/v1/voice-upload HTTP/1.1");
  client.println("Host: njpxixfcctodjejtgmwj.supabase.co");
  client.println("Content-Type: multipart/form-data; boundary=" + boundary);
  client.println("Content-Length: " + String(totalLen));
  client.println("Connection: close");
  client.println();
  client.print(head);

  // Stream the file in chunks rather than loading it whole into RAM.
  uint8_t buf[512];
  while (f.available()) {
    size_t n = f.read(buf, sizeof(buf));
    client.write(buf, n);
  }
  f.close();
  client.print(tail);

  // ---- read response ----
  unsigned long start = millis();
  while (client.connected() && !client.available() && (millis() - start) < 20000) {
    delay(10);
  }

  String statusLine = client.readStringUntil('\n');
  Serial.println("UPLOAD HTTP RESPONSE: " + statusLine);

  // Skip headers
  while (client.connected()) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break;
  }
  String body = client.readString();
  client.stop();

  bool ok = statusLine.indexOf("200") > 0;
  if (ok) {
    Serial.println("UPLOAD SUCCESS: " + body);
  } else {
    Serial.println("UPLOAD FAILED: " + body);
  }
  return ok;
}

// ============================================================
// TTS polling + playback
// ============================================================

bool pollAndPlayResponse() {
  Serial.println("POLLING for TTS response");
  unsigned long start = millis();

  while ((millis() - start) < POLL_TIMEOUT_MS) {
    WiFiClientSecure client;
    client.setInsecure(); // prototype-only, see uploadRecording() comment

    HTTPClient http;
    String url = String(VOICE_FETCH_URL) + "?device_key=" + String(DEVICE_API_KEY);
    if (!http.begin(client, url)) {
      Serial.println("POLL: http.begin() failed, retrying...");
      delay(POLL_INTERVAL_MS);
      continue;
    }

    int code = http.GET();

    if (code == 204) {
      http.end();
      delay(POLL_INTERVAL_MS);
      continue; // nothing queued yet — normal, keep polling
    }

    if (code == 200) {
      Serial.println("TTS audio available — downloading.");
      WiFiClient *stream = http.getStreamPtr();
      int len = http.getSize();

      if (LittleFS.exists(RESPONSE_PATH)) LittleFS.remove(RESPONSE_PATH);
      File out = LittleFS.open(RESPONSE_PATH, FILE_WRITE);
      if (!out) {
        Serial.println("PLAYBACK_ERROR: could not open response file for write.");
        http.end();
        return false;
      }

      uint8_t buf[512];
      int written = 0;
      unsigned long dlStart = millis();
      while (http.connected() && (len < 0 || written < len)) {
        size_t avail = stream->available();
        if (avail) {
          int n = stream->readBytes(buf, min((size_t)sizeof(buf), avail));
          out.write(buf, n);
          written += n;
        } else if ((millis() - dlStart) > 15000) {
          Serial.println("PLAYBACK_ERROR: download stalled, aborting.");
          break;
        }
        delay(1);
      }
      out.close();
      http.end();

      Serial.printf("Downloaded %d bytes to %s\n", written, RESPONSE_PATH);
      playMp3File(RESPONSE_PATH);
      return true;
    }

    // Any other status — treat as a transient error and keep polling
    // until the overall timeout; a single hiccup shouldn't abandon the
    // whole cycle when the transcript may still be processing upstream.
    Serial.printf("POLL: unexpected status %d, retrying...\n", code);
    http.end();
    delay(POLL_INTERVAL_MS);
  }

  Serial.println("STT_ERROR/TTS_ERROR: poll timed out with no response.");
  return false;
}

void playMp3File(const String &path) {
  // IMPORTANT LIMITATION, stated plainly rather than glossed over:
  // MAX98357A is a PCM I2S DAC/amp — it does not decode MP3 on its own.
  // Playing the MP3 bytes voice-fetch returns requires an MP3 decoder
  // running on the ESP32 (e.g. the Arduino ESP32-audioI2S / ESP8266Audio
  // library family, which several ESP32 I2S+MAX98357A projects use) that
  // decodes MP3 frames into PCM and feeds them to i2s_write() below. That
  // decoder library is NOT included in this sketch — it depends on which
  // library the rest of this firmware already uses/prefers, which was
  // not specified, and pulling in a new audio-decoding dependency
  // correctly is exactly the kind of thing that should be a deliberate
  // choice, not a guess baked into a generated file.
  //
  // What IS implemented and correct below: the I2S TX configuration and
  // teardown sequencing, and the file-streaming pattern any decoder would
  // plug into (read PCM frames from decoder output, i2s_write() them out
  // in chunks, matching the same non-buffer-the-whole-thing approach used
  // for recording). If Sarvam's speak() were instead asked for a PCM/WAV
  // output instead of MP3 (output_audio_codec in supabase/functions/
  // speak/index.ts is currently hardcoded to "mp3" — see PART 8's own
  // note that speak() itself was deliberately NOT modified this pass),
  // this function could i2s_write() the downloaded bytes directly with
  // no decoder at all, which is the simplest fix if changing that one
  // line is acceptable.

  Serial.println("PLAYING (stub — see comment above: MP3 decoding not implemented in this sketch)");

  File f = LittleFS.open(path, FILE_READ);
  if (!f) {
    Serial.println("PLAYBACK_ERROR: could not open response file.");
    return;
  }

  i2sConfigureTx();

  // Placeholder playback loop: writes the RAW MP3 bytes to I2S, which
  // will NOT sound correct (MP3 is compressed, not PCM) — this proves
  // the I2S TX path, DMA buffering, and RX/TX teardown sequencing are
  // wired correctly, but real audio requires the decoder noted above.
  uint8_t buf[512];
  size_t bytesWritten;
  while (f.available()) {
    size_t n = f.read(buf, sizeof(buf));
    i2s_write(I2S_NUM_0, buf, n, &bytesWritten, 100 / portTICK_PERIOD_MS);
  }
  f.close();

  i2sTeardown();
  Serial.println("Playback stream finished.");
}

// ============================================================
// WiFi credential storage + connection
// ============================================================

void loadWifiCredentials(String &ssid, String &password) {
  ssid = prefs.getString("ssid", "");
  password = prefs.getString("password", "");
}

void saveWifiCredentials(const String &ssid, const String &password) {
  prefs.putString("ssid", ssid);
  prefs.putString("password", password);
}

bool connectWifi(const String &ssid, const String &password, uint32_t timeoutMs) {
  Serial.println("Connecting to WiFi: " + ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid.c_str(), password.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < timeoutMs) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  return WiFi.status() == WL_CONNECTED;
}

// ============================================================
// WiFi setup AP + captive portal page
// ============================================================

void startSetupAP() {
  apMode = true;
  WiFi.mode(WIFI_AP);
  WiFi.softAP("VoiceButton-Setup", "voice1234");
  Serial.println("Setup AP started. Connect to 'VoiceButton-Setup' (password: voice1234) and browse to http://192.168.4.1");

  setupServer.on("/", HTTP_GET, handleSetupRoot);
  setupServer.on("/save", HTTP_POST, handleSetupSave);
  setupServer.begin();
}

void handleSetupRoot() {
  // Deliberately no WiFi.scanNetworks() — per project constraint, prior
  // scan testing was unreliable on this hardware. Manual entry only,
  // plus two named quick-fill options for this project's known networks.
  String html =
      "<!DOCTYPE html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<title>Voice Button Setup</title>"
      "<style>body{font-family:sans-serif;max-width:420px;margin:24px auto;padding:0 16px}"
      "input,select,button{width:100%;padding:10px;margin:6px 0;font-size:16px;box-sizing:border-box}"
      "button{background:#0f766e;color:#fff;border:none;border-radius:6px}</style></head><body>"
      "<h2>Voice Button WiFi Setup</h2>"
      "<form action='/save' method='POST'>"
      "<label>Quick option</label>"
      "<select id='quick' onchange='document.getElementById(\"ssid\").value=this.value.startsWith(\"__\")?\"\":this.value'>"
      "<option value='__custom'>Custom network</option>"
      "<option value='MARINE EDGE'>MARINE EDGE</option>"
      "<option value='MARINE_EDGE'>MARINE_EDGE</option>"
      "</select>"
      "<label>SSID</label>"
      "<input type='text' id='ssid' name='ssid' placeholder='Network name' required>"
      "<label>Password</label>"
      "<input type='password' name='password' placeholder='WiFi password'>"
      "<button type='submit'>Save &amp; Connect</button>"
      "</form></body></html>";
  setupServer.send(200, "text/html", html);
}

void handleSetupSave() {
  String ssid = setupServer.arg("ssid");
  String password = setupServer.arg("password");

  if (ssid.length() == 0) {
    setupServer.send(400, "text/plain", "SSID is required.");
    return;
  }

  saveWifiCredentials(ssid, password);
  setupServer.send(200, "text/html",
                    "<html><body><h3>Saved. Restarting...</h3></body></html>");
  delay(1000);
  ESP.restart();
}
