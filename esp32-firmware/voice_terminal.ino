/* =====================================================================
   Sahakar Saathi — ESP32-C3 Voice Terminal
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
        see the transcript) -> on HTTP 200, /recording.wav is DELETED
        (it's already durably uploaded, never read back locally) ->
        POLLING voice-fetch for the TTS reply
     -> PLAYING: response WAV is STREAMED, never written to LittleFS.
        Its RIFF/fmt/data header is parsed directly off the live HTTPS
        body (parseWavHeaderStream) rather than assuming a fixed format,
        audio bytes flow network -> a small RAM ring buffer
        (AUDIO_RINGBUF_BYTES) -> I2S TX (streamPlayResponse), with a
        short pre-buffer before I2S starts so a brief network stall
        doesn't immediately underrun playback. This removes the earlier
        LittleFS-space ceiling on reply length entirely — a long AI
        response's synthesized audio no longer needs to fit in the
        device's flash at all, only in the ring buffer's short rolling
        window -> IDLE.
        No MP3 decoder — the backend's speak() now requests Sarvam's
        "wav"/PCM codec instead of MP3, so the bytes voice-fetch returns
        are already playable PCM once past the WAV header.

   LittleFS is used ONLY for /recording.wav now (the mic side, streamed
   to flash during recording since that side's duration is bounded by
   MAX_RECORD_SECONDS and needs to survive the upload's own retry path).
   /recording.wav is removed immediately after a confirmed-successful
   upload, before polling begins — this was the fix for an earlier
   "No more free space" bug where a lingering recording.wav plus a
   downloaded response.wav together exceeded the partition; that whole
   class of problem no longer applies to the response side at all now
   that it's never written to flash.

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
    "https://qstqjrlcdihyawszaqis.supabase.co/functions/v1/voice-upload";
static const char *VOICE_FETCH_URL =
    "https://qstqjrlcdihyawszaqis.supabase.co/functions/v1/voice-fetch";

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
// No RESPONSE_PATH: response playback is streamed directly from the
// network into a RAM ring buffer and out to I2S -- never written to
// LittleFS at all. See streamPlayResponse() below.

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
// A long AI reply (200+ words) takes longer to synthesize server-side
// (Gemini generation + a single Sarvam TTS call over the whole reply)
// before voice-output ever queues anything for voice-fetch to return.
// 30s was tight enough to time out on long replies even though the
// pipeline was still going to succeed a few seconds later -- raised to
// 120s so the device doesn't give up on a slow-but-healthy turn.
#define POLL_TIMEOUT_MS  120000

// Idle replay polling. Separate from the post-upload poll above: that one
// is a tight 500ms loop bounded by POLL_TIMEOUT_MS, because a reply to a
// question the user JUST asked is expected within seconds and the device
// has nothing else to do while waiting. This one instead runs forever, in
// the background, while the device sits in ST_IDLE -- it exists so the
// dashboard's per-message "replay on the speaker" button reaches the
// hardware at all. Without it, voice-output would queue a clip that
// nothing ever collects until the next push-to-talk, where it would be
// picked up as if it were the answer to that new question.
//
// 3s (not 500ms) because this runs indefinitely rather than for a bounded
// window: at 500ms an idle device would issue ~172k requests a day, each
// paying a full TLS handshake, purely to be told 204 No Content almost
// every time. 3s keeps replay latency well within "press button, it
// speaks" territory while cutting that by 6x. The check is additionally
// gated on WL_CONNECTED so a device that dropped WiFi doesn't burn the
// whole loop on connect() attempts that cannot succeed.
#define IDLE_POLL_INTERVAL_MS 3000

// Streaming playback ring buffer. 32KB chosen conservatively: real
// hardware logs from this project's own upload path (ESP.getFreeHeap(),
// logged during active WiFiClientSecure/TLS use) showed 180-190KB free
// heap with TLS already active, so 32KB leaves comfortable headroom
// rather than targeting the riskier 64KB end of the suggested range.
#define AUDIO_RINGBUF_BYTES (32 * 1024)
// Pre-buffer this many bytes before starting I2S playback, so a short
// network stall right after playback starts doesn't immediately
// underrun. ~1s of audio at the confirmed 16kHz/16-bit/mono format this
// project's speak() produces (32000 bytes/s), capped below the ring
// buffer's own size so pre-buffering can never itself deadlock waiting
// for more room than the buffer could ever hold.
#define AUDIO_PREBUFFER_BYTES (16 * 1024)

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

// Boot-time touch-input settle guard. Real hardware showed a spurious
// press+release pair firing on its own, with zero physical touch, right
// at the point WiFi association completes in setup() -- ESP32 WiFi radio
// activation is a known source of transient GPIO noise, and GPIO3 has no
// special shielding here. touchArmed stays false (the pin is not trusted
// yet) until loop() has observed TOUCH_ARM_STABLE_READS consecutive LOW
// readings, each separated by at least one loop iteration -- so a single
// glitch sample can never itself arm the input, and any transition
// during the guard window is discarded outright rather than being fed
// into the debounce/state-machine logic at all.
static bool touchArmed = false;
static int touchArmStableCount = 0;
#define TOUCH_ARM_STABLE_READS 20

// Tap-gesture tracking
static int tapCount = 0;
static unsigned long firstTapAtMs = 0;

// Idle replay polling (see IDLE_POLL_INTERVAL_MS). Starts at 0 rather
// than millis() so the very first check happens promptly after boot
// instead of waiting out a full interval -- if a clip was queued while
// the device was powered off, it plays as soon as WiFi comes up.
static unsigned long lastIdlePollMs = 0;

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
void i2sConfigureTx(uint32_t sampleRate, uint16_t bitsPerSample, uint16_t numChannels);
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
bool checkForQueuedAudio();

struct WavInfo; // full definition below, near parseWavHeaderStream/streamPlayResponse
struct RingBuffer; // full definition below, near streamPlayResponse
bool streamPlayResponse(HTTPClient &http);

// ============================================================
// setup / loop
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Sahakar Saathi Voice Terminal booting ===");

  // INPUT_PULLDOWN (not plain INPUT): actively holds the pin LOW via the
  // ESP32's own internal pulldown whenever the TTP223 isn't driving it
  // HIGH, instead of relying solely on the sensor's own output drive plus
  // an otherwise-floating internal input state. This directly reduces
  // susceptibility to the transient noise (e.g. from WiFi radio
  // activation) that was causing spurious touch events with no physical
  // touch -- paired with the boot-time settle guard below.
  pinMode(PIN_TOUCH, INPUT_PULLDOWN);

  // Same reasoning as the pinMode/digitalWrite added to i2sTeardown():
  // before the very first i2sConfigureTx()/i2sConfigureRx() call, this
  // pin has never been claimed by anything and floats at whatever level
  // noise leaves it at -- drive it low here too so the amp's input is
  // defined from the moment the board boots, not just after the first
  // playback cycle.
  pinMode(PIN_I2S_SD_OUT, OUTPUT);
  digitalWrite(PIN_I2S_SD_OUT, LOW);

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

  // ---- boot-time settle guard ----
  // Do not trust the touch pin at all until it has read a stable LOW for
  // TOUCH_ARM_STABLE_READS consecutive loop iterations. Any HIGH seen
  // before arming is discarded outright (not fed into debounce/state
  // logic) and resets the stable-count back to zero, so a glitch pulse
  // during the guard window can only delay arming, never itself trigger
  // onTouchDown/onTouchRelease. This is what actually stops the spurious
  // press+release pair observed on real hardware right at WiFi-connect
  // time, before a user has touched anything.
  if (!touchArmed) {
    if (level == LOW) {
      touchArmStableCount++;
      if (touchArmStableCount >= TOUCH_ARM_STABLE_READS) {
        touchArmed = true;
        lastTouchLevel = LOW;
        lastTouchChangeMs = now;
        Serial.println("[TOUCH] Input armed (stable).");
      }
    } else {
      touchArmStableCount = 0; // glitch or genuine early touch -- either way, keep waiting for a stable LOW run
    }
    return; // touch/recording logic stays fully inactive until armed
  }

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

  // ---- idle replay poll ----
  // Only while genuinely idle: ST_IDLE excludes recording/uploading/
  // polling/playing (those paths own the network and the I2S peripheral
  // and must not have a second fetch racing them), and tapCount == 0
  // excludes ST_SETUP_GESTURE's in-progress tap sequence, so a
  // multi-second playback can't start between taps 2 and 3 and swallow
  // the rest of the WiFi-setup gesture. WL_CONNECTED gates out the
  // no-network case entirely rather than retrying a doomed connect().
  //
  // checkForQueuedAudio() briefly blocks for one HTTP round trip (and,
  // on a 200, for the length of the clip) -- acceptable here precisely
  // because it only runs when there is nothing else in flight, and the
  // touch pin is re-read at the top of the very next iteration.
  if (state == ST_IDLE && tapCount == 0 && WiFi.status() == WL_CONNECTED &&
      (now - lastIdlePollMs) >= IDLE_POLL_INTERVAL_MS) {
    lastIdlePollMs = now;
    checkForQueuedAudio();
  }
}

// ============================================================
// Touch event handlers
// ============================================================

void onTouchDown(unsigned long now) {
  Serial.println("[TOUCH] Pressed");

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
  Serial.println("[TOUCH] Released");

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
  Serial.println("[RECORD] Released — finalizing.");
  finalizeRecording();

  state = ST_UPLOADING;
  Serial.println("[UPLOAD] Uploading...");
  bool uploaded = uploadRecording();

  if (!uploaded) {
    Serial.println("[ERROR] Upload failed — returning to IDLE.");
    // Recording is still on LittleFS here on purpose: if upload failed
    // (network blip, server error) the file isn't yet known-consumed by
    // the backend, so it's kept rather than discarded — a future retry
    // policy could re-upload it. It IS removed below on the success path,
    // which is the actual fix for this bug: two ~1.4MB files (a lingering
    // recording.wav plus an incoming response.wav) is what exhausted
    // LittleFS and produced the truncated, unparseable response.wav.
    state = ST_IDLE;
    return;
  }
  Serial.println("[UPLOAD] HTTP 200 — upload successful.");

  // ---- FIX: free the recording's space before downloading the reply ----
  // The recording has already been durably accepted by voice-upload (we
  // only reach here on a confirmed HTTP 200) and is not needed locally
  // again — nothing in this firmware ever reads it back. Removing it now,
  // before polling starts, is what keeps at most ONE large WAV on
  // LittleFS at any time, which is the actual fix: this device's
  // LittleFS partition cannot hold a ~1.4MB recording AND a ~1.4MB
  // response simultaneously.
  Serial.println("[FS] Removing recording.wav");
  if (recordingFile) recordingFile.close(); // defensive: finalizeRecording() already closed it, but never leave a handle open before a remove()
  if (LittleFS.exists(RECORDING_PATH)) {
    if (LittleFS.remove(RECORDING_PATH)) {
      Serial.println("[FS] recording.wav removed");
    } else {
      Serial.println("[ERROR] Failed to remove recording.wav — continuing anyway, but LittleFS space is now at risk.");
    }
  }
  if (LittleFS.exists(RECORDING_PATH)) {
    // Verify removal actually took effect, per the requirement — a
    // filesystem remove() can nominally return true while the entry is
    // still present under some corruption/error conditions worth
    // catching explicitly rather than assuming success.
    Serial.println("[ERROR] recording.wav still exists after remove() — LittleFS may be in a bad state.");
  }
  Serial.printf("[FS] Free space: %u / %u bytes\n", (unsigned)(LittleFS.totalBytes() - LittleFS.usedBytes()), (unsigned)LittleFS.totalBytes());

  state = ST_POLLING;
  bool played = pollAndPlayResponse();
  if (!played) {
    Serial.println("[ERROR] No TTS response played this cycle (timeout, download, or playback failure — see logs above).");
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

// Sample rate, channel count and bit depth are runtime parameters, not
// compile-time constants — per the deadline requirement, this firmware
// does not assume the TTS output format; it parses the actual WAV
// header (see parseWavHeader() below) and configures I2S TX from
// whatever that header actually says, whether or not it matches the
// 16kHz/16-bit/mono that speak() currently requests.
void i2sConfigureTx(uint32_t sampleRate, uint16_t bitsPerSample, uint16_t numChannels) {
  i2s_bits_per_sample_t bits =
      (bitsPerSample == 8) ? I2S_BITS_PER_SAMPLE_8BIT :
      (bitsPerSample == 24) ? I2S_BITS_PER_SAMPLE_24BIT :
      (bitsPerSample == 32) ? I2S_BITS_PER_SAMPLE_32BIT :
      I2S_BITS_PER_SAMPLE_16BIT; // default/most common case, matches speak()'s current output

  i2s_channel_fmt_t channelFmt =
      (numChannels >= 2) ? I2S_CHANNEL_FMT_RIGHT_LEFT : I2S_CHANNEL_FMT_ONLY_LEFT;

  i2s_config_t cfg = {
      .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
      .sample_rate = sampleRate,
      .bits_per_sample = bits,
      .channel_format = channelFmt,
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

  // i2s_driver_uninstall() releases the I2S peripheral's control of its
  // pins -- including PIN_I2S_SD_OUT (GPIO7, the MAX98357A's DIN), which
  // is left floating until the next i2sConfigureTx() call. The very next
  // I2S activity is usually i2sConfigureRx() for a new recording (it sets
  // data_out_num = I2S_PIN_NO_CHANGE, so it never touches this pin at
  // all), which re-clocks BCLK/WS (shared between mic and amp) while the
  // amp's DIN is still floating -- the amp is still physically wired to
  // those same clock lines and amplifies whatever noise is present on its
  // floating input the instant it sees valid clocking again. This is
  // exactly the click/pop heard right at touch-down (the moment
  // beginRecording() -> i2sConfigureRx() runs next). Explicitly driving
  // this pin LOW (silence) as a plain GPIO immediately after every
  // teardown keeps the amp's input defined and silent whenever I2S isn't
  // actively driving it for real playback.
  pinMode(PIN_I2S_SD_OUT, OUTPUT);
  digitalWrite(PIN_I2S_SD_OUT, LOW);
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
  Serial.println("[RECORD] Started");

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
  Serial.printf("[RECORD] Finalized WAV: %u bytes PCM (%.2fs)\n",
                recordedBytes, recordedBytes / (float)(SAMPLE_RATE * 2));
}

// ============================================================
// Upload: single multipart/form-data POST to voice-upload
// ============================================================
//
// History (kept brief -- see git log for the full investigation): the
// original single-shot HTTPClient::POST() upload failed on real hardware.
// This was chased through several hypotheses -- a core-level TLS write
// defect, then a chunked upload protocol to work around it, then
// (wrongly) connection-reuse exhaustion, then (wrongly) connection reuse
// itself -- before the real cause was isolated: HTTPClient::POST()'s own
// internal body-write path was unreliable on this specific device for
// request bodies above roughly 1KB, for reasons never fully identified
// (the installed core's actual TLS write loop, read from its real
// source, is already correct). Replacing HTTPClient::POST() with a
// manual write directly over WiFiClientSecure -- every write() call's
// return value checked and short writes retried, rather than trusting
// any library-internal loop -- fixed it: a full ~135KB upload as ~133
// small chunked requests completed successfully on real hardware.
//
// That confirmed the actual defect was HTTPClient's write path, not
// request size. Chunking was a workaround for a problem that no longer
// exists once that path is bypassed, and ~133 requests each paying a
// full fresh TLS handshake was too slow for a live demo (~60-100s just
// in handshake overhead). This is the final design: upload the whole WAV
// as ONE multipart/form-data POST, using the same manual-write
// discipline that's now proven correct, applied to a single larger body
// streamed from LittleFS in bounded RAM chunks instead of many small
// ones. One TLS handshake per recording. Uses voice-upload's ORIGINAL
// multipart contract (Shape A in that function's own comments) --
// already deployed, unchanged, no backend redeploy needed.
//
// writeAllRetry() below is the one piece of transport code shared by
// both this and the (now-removed) chunked path's postJson() -- explicit
// per-write verification is what actually fixed the real defect, and
// stays the core discipline for every network write in this firmware.
static bool writeAllRetry(WiFiClientSecure &client, const uint8_t *data, size_t len) {
  size_t sent = 0;
  const size_t SUBWRITE = 256; // small enough to have been directly verified working via curl at this and smaller sizes
  unsigned long lastProgress = millis();
  while (sent < len) {
    size_t toWrite = min(SUBWRITE, len - sent);
    size_t n = client.write(data + sent, toWrite);
    if (n > 0) {
      sent += n;
      lastProgress = millis();
    } else {
      if (!client.connected()) return false; // connection genuinely gone -- no point retrying
      if (millis() - lastProgress > 10000) return false; // stalled with zero progress for 10s -- give up rather than hang forever
      delay(5);
    }
  }
  return true;
}

// Reads an HTTP response (status line, headers, chunked-or-not body) from
// an already-connected, already-request-sent WiFiClientSecure. Shared by
// uploadMultipart() below; factored out rather than duplicated since this
// parsing logic (especially the chunked-transfer decode) is the one part
// of the manual-write rewrite worth keeping in exactly one place. Every
// wait loop has its own explicit millis()-based timeout so nothing can
// hang indefinitely regardless of what the server does or doesn't send.
// Returns the HTTP status code, or a negative HTTPClient-style error code
// on any transport-level failure; `outBody` holds the response body text
// on success.
static int readHttpResponse(WiFiClientSecure &client, String &outBody) {
  unsigned long waitStart = millis();
  while (!client.available() && client.connected()) {
    if (millis() - waitStart > 15000) {
      client.stop();
      outBody = "";
      return -11; // same convention as HTTPC_ERROR_READ_TIMEOUT for continuity with prior logs
    }
    delay(5);
  }

  String statusLine = client.readStringUntil('\n');
  int statusCode = -1;
  int firstSpace = statusLine.indexOf(' ');
  if (firstSpace > 0) {
    int secondSpace = statusLine.indexOf(' ', firstSpace + 1);
    String codeStr = secondSpace > 0 ? statusLine.substring(firstSpace + 1, secondSpace) : statusLine.substring(firstSpace + 1);
    statusCode = codeStr.toInt();
  }
  if (statusCode <= 0) {
    client.stop();
    outBody = "";
    return -1;
  }

  // Skip response headers -- only the status code and body are needed,
  // not individual header values.
  bool chunked = false;
  while (true) {
    String line = client.readStringUntil('\n');
    if (line == "\r" || line.length() == 0) break; // blank line = end of headers
    String lower = line;
    lower.toLowerCase();
    if (lower.indexOf("transfer-encoding:") >= 0 && lower.indexOf("chunked") >= 0) chunked = true;
  }

  outBody = "";
  if (chunked) {
    // Minimal chunked-transfer decode: hex size line, that many bytes,
    // trailing CRLF, repeat until a zero-size chunk.
    while (true) {
      String sizeLine = client.readStringUntil('\n');
      sizeLine.trim();
      long chunkSize = strtol(sizeLine.c_str(), nullptr, 16);
      if (chunkSize <= 0) break;
      char *buf = (char *)malloc(chunkSize + 1);
      if (!buf) break;
      int readTotal = 0;
      unsigned long readStart = millis();
      bool chunkTimedOut = false;
      while (readTotal < chunkSize) {
        if (client.available()) {
          int n = client.readBytes(buf + readTotal, chunkSize - readTotal);
          readTotal += n;
          readStart = millis(); // reset on real progress, same pattern as writeAllRetry
        } else if (millis() - readStart > 10000) {
          chunkTimedOut = true;
          break;
        } else {
          delay(2);
        }
      }
      buf[readTotal] = '\0';
      outBody += buf;
      free(buf);
      // A short/timed-out chunk body leaves the stream desynced from the
      // chunked-encoding framing (the trailing CRLF this chunk should end
      // with is not where a short read left the cursor) -- stop parsing
      // immediately rather than reading a bogus "next chunk size" out of
      // what is actually still this chunk's own body.
      if (chunkTimedOut) break;
      client.readStringUntil('\n'); // trailing CRLF after each chunk
    }
  } else {
    // Not expected in practice -- voice-upload always sends chunked
    // responses (confirmed via curl -v against the live server) -- but
    // kept correct rather than left as a possible infinite loop: bails
    // after 10s with no new byte, same convention as every other wait
    // loop in this function.
    unsigned long lastByte = millis();
    while (client.connected() || client.available()) {
      if (client.available()) {
        outBody += (char)client.read();
        lastByte = millis();
      } else if (millis() - lastByte > 10000) {
        break;
      } else {
        delay(2);
      }
      if (outBody.length() > 4096) break; // response bodies from this endpoint are always small JSON; a runaway read is a bug elsewhere, not a real response
    }
  }

  client.stop();
  return statusCode;
}

// Fourth real-hardware result: the manual-write postJson() (previous
// commit) WORKED -- a full chunked upload (133 requests at 1024 bytes
// each) completed successfully, transcript came back correctly. That
// confirms the actual defect was HTTPClient::POST()'s internal body-
// write path, now bypassed. But 133 sequential requests, each paying its
// own fresh TLS handshake (connect() + full handshake, no reuse), is
// slow in aggregate -- roughly a minute of pure handshake overhead for a
// ~135KB recording, which is unacceptable for a live demo.
//
// Now that the actual write defect is confirmed fixed (not chunk size,
// not connection reuse -- the HTTPClient body-write path itself), there
// is no remaining reason to chunk at all: send the whole WAV as ONE
// multipart/form-data POST, using the SAME manual-write discipline
// (explicit write() return value checked and retried, never trusted to
// a library's internal loop) that just proved itself correct, applied to
// a single larger body instead of many small ones. This uses
// voice-upload's ORIGINAL multipart contract (Shape A in that function's
// own comments) -- already deployed, unchanged, needs no backend
// redeploy. One TLS handshake per recording instead of ~133.
static bool uploadMultipart(File &f, size_t fileSize, String &outBody) {
  WiFiClientSecure client;
  // Prototype-only: skips TLS certificate validation. Isolated here and
  // clearly commented -- replace with a pinned root CA before any
  // production deployment of this firmware.
  client.setInsecure();
  client.setConnectionTimeout(10000);

  static const char *HOST = "qstqjrlcdihyawszaqis.supabase.co";
  static const char *PATH = "/functions/v1/voice-upload";

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

  if (!client.connect(HOST, 443)) {
    outBody = "";
    return false;
  }

  String headers;
  headers.reserve(200);
  headers += "POST " + String(PATH) + " HTTP/1.1\r\n";
  headers += "Host: " + String(HOST) + "\r\n";
  headers += "Content-Type: multipart/form-data; boundary=" + boundary + "\r\n";
  headers += "Content-Length: " + String(totalLen) + "\r\n";
  headers += "Connection: close\r\n\r\n";

  if (!writeAllRetry(client, (const uint8_t *)headers.c_str(), headers.length())) {
    client.stop();
    outBody = "";
    return false;
  }
  if (!writeAllRetry(client, (const uint8_t *)head.c_str(), head.length())) {
    client.stop();
    outBody = "";
    return false;
  }

  // Stream the WAV file straight from LittleFS in bounded RAM chunks --
  // never loaded whole into memory, same guarantee every prior version
  // of this firmware has kept.
  static uint8_t fileBuf[4096]; // matches send_ssl_data's own internal 4096-byte sub-write size (confirmed in the real ssl_client.cpp source) -- the natural chunk size to hand it
  size_t sentFile = 0;
  uint32_t lastProgressLog = 0;
  while (sentFile < fileSize) {
    size_t n = f.read(fileBuf, sizeof(fileBuf));
    if (n == 0) break; // shouldn't happen given fileSize, but don't loop forever if it does
    if (!writeAllRetry(client, fileBuf, n)) {
      client.stop();
      outBody = "";
      return false;
    }
    sentFile += n;
    if (sentFile - lastProgressLog >= 32768 || sentFile >= fileSize) {
      Serial.printf("[UPLOAD] Progress: %u / %u (free heap=%u)\n", (unsigned)sentFile, (unsigned)fileSize, (unsigned)ESP.getFreeHeap());
      lastProgressLog = sentFile;
    }
  }

  if (!writeAllRetry(client, (const uint8_t *)tail.c_str(), tail.length())) {
    client.stop();
    outBody = "";
    return false;
  }

  // The response only starts arriving after the whole file has finished
  // uploading AND been transcribed server-side (voice-upload's handler
  // calls Sarvam before responding), so this can legitimately take a few
  // seconds longer than a small chunk request's response did -- see
  // readHttpResponse()'s own 15s wait-for-first-byte timeout.
  int statusCode = readHttpResponse(client, outBody);
  return statusCode == 200;
}

bool uploadRecording() {
  Serial.println("UPLOADING");

  File f = LittleFS.open(RECORDING_PATH, FILE_READ);
  if (!f) {
    Serial.println("UPLOAD_ERROR: could not reopen recording file.");
    return false;
  }
  size_t fileSize = f.size();
  Serial.printf("[UPLOAD] Target URL:  %s\n", VOICE_UPLOAD_URL);
  Serial.printf("[UPLOAD] WAV file size: %u bytes (single multipart request)\n", (unsigned)fileSize);

  String resp;
  bool ok = uploadMultipart(f, fileSize, resp);
  f.close();

  Serial.printf("[UPLOAD] %s: %s\n", ok ? "SUCCESS" : "FAILED", resp.c_str());
  return ok;
}

// ============================================================
// TTS polling + playback
// ============================================================

bool pollAndPlayResponse() {
  Serial.println("[POLL] Waiting for response...");
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
      Serial.println("[POLL] Response received");
      bool played = streamPlayResponse(http);
      http.end();
      return played;
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

// ONE non-blocking voice-fetch check, for the idle path only.
//
// Deliberately NOT reusing pollAndPlayResponse(): that function blocks
// the caller for up to POLL_TIMEOUT_MS (120s) retrying in a tight loop,
// which is correct right after an upload (the device is committed to
// waiting for that specific reply and has nothing else to do) but would
// be wrong here -- loop() must stay responsive to touch input, and a
// device sitting idle has no reason to believe a clip is coming at all.
// So this makes exactly one request and returns immediately either way:
// 204 (the overwhelmingly common case) costs one round trip and nothing
// else, and only an actual 200 hands off to the same streamPlayResponse()
// the post-upload path uses -- identical playback behavior, identical
// consumed-marking server-side, just a different trigger.
//
// Returns true only if a clip was actually fetched AND played.
bool checkForQueuedAudio() {
  WiFiClientSecure client;
  client.setInsecure(); // prototype-only, same as every other call in this firmware

  HTTPClient http;
  String url = String(VOICE_FETCH_URL) + "?device_key=" + String(DEVICE_API_KEY);
  if (!http.begin(client, url)) return false; // silent: an idle-path failure is not worth logging every 3s

  int code = http.GET();

  if (code == 200) {
    Serial.println("[IDLE] Queued audio found — playing.");
    bool played = streamPlayResponse(http);
    http.end();
    return played;
  }

  // 204 (nothing queued) is the normal, expected case here and is
  // intentionally not logged -- it would otherwise flood Serial with a
  // line every 3 seconds forever. Anything else is a real anomaly worth
  // seeing, but still non-fatal: just try again on the next interval.
  if (code != 204) {
    Serial.printf("[IDLE] voice-fetch unexpected status %d\n", code);
  }
  http.end();
  return false;
}

// ============================================================
// Streaming WAV playback: network -> RAM ring buffer -> I2S
// ============================================================
//
// Replaces the previous design (download the whole response to
// /response.wav on LittleFS, close it, reopen it, play it). That design
// capped every reply at whatever free LittleFS space remained (observed
// on real hardware: a long reply's ~2MB WAV exceeded the ~1.4MB free
// partition and was correctly refused rather than corrupted -- but that
// refusal is itself the problem this replaces). Streaming removes the
// cap entirely: audio is played as it arrives over HTTPS, a small
// (AUDIO_RINGBUF_BYTES) RAM buffer sits between the network and I2S, and
// the response is never written to flash at all. RESPONSE_PATH,
// validateWavFile(), playWavFile(), and the File-based parseWavHeader()
// are removed as obsolete -- nothing else in this firmware ever wrote to
// or read RESPONSE_PATH except the code this replaces.
//
// Backend contract (unchanged): speak() (supabase/functions/speak/
// index.ts) requests Sarvam's "wav" codec at speech_sample_rate=16000 --
// confirmed live earlier in this project against the deployed function.
// The sample rate/bit depth/channel count are still parsed from the
// actual WAV header rather than assumed, exactly as before -- this
// firmware still adapts if speak() is ever retuned.

struct WavInfo {
  uint16_t audioFormat;
  uint16_t numChannels;
  uint32_t sampleRate;
  uint16_t bitsPerSample;
  uint32_t dataSize;     // from the WAV header -- a hint for logging/UX, not trusted as the sole end-of-audio signal (see streamPlayResponse)
};

// Simple fixed-size ring buffer, no dynamic allocation (avoids heap
// fragmentation risk from repeated malloc/free across many playback
// cycles over the device's lifetime). Single-producer (network fill),
// single-consumer (I2S drain), both driven from the same single-threaded
// call site in streamPlayResponse() below -- no concurrent access, so no
// locking is needed despite this looking superficially like a
// producer/consumer structure.
struct RingBuffer {
  uint8_t *data;
  size_t capacity;
  volatile size_t head; // next write position
  volatile size_t tail; // next read position
  volatile size_t count; // bytes currently held -- kept explicit rather than derived from head/tail so "full" and "empty" (both head==tail) are unambiguous
};

static void ringInit(RingBuffer &rb, uint8_t *buf, size_t capacity) {
  rb.data = buf;
  rb.capacity = capacity;
  rb.head = 0;
  rb.tail = 0;
  rb.count = 0;
}

static size_t ringFree(RingBuffer &rb) {
  return rb.capacity - rb.count;
}

// Copies up to `len` bytes from `src` into the ring buffer, wrapping as
// needed. Returns the number actually copied (<= ringFree()) -- caller
// must check this against what it intended to write, same
// verify-every-write discipline used for network writes in
// writeAllRetry() above.
static size_t ringWrite(RingBuffer &rb, const uint8_t *src, size_t len) {
  size_t toWrite = min(len, ringFree(rb));
  size_t firstPart = min(toWrite, rb.capacity - rb.head);
  memcpy(rb.data + rb.head, src, firstPart);
  if (toWrite > firstPart) {
    memcpy(rb.data, src + firstPart, toWrite - firstPart);
  }
  rb.head = (rb.head + toWrite) % rb.capacity;
  rb.count += toWrite;
  return toWrite;
}

// Copies up to `len` bytes out of the ring buffer into `dst`. Returns the
// number actually copied (<= rb.count).
static size_t ringRead(RingBuffer &rb, uint8_t *dst, size_t len) {
  size_t currentCount = rb.count; // snapshot into a plain (non-volatile) local -- std::min requires both arguments to share the same cv-qualification, and rb.count is declared volatile
  size_t toRead = min(len, currentCount);
  size_t firstPart = min(toRead, rb.capacity - rb.tail);
  memcpy(dst, rb.data + rb.tail, firstPart);
  if (toRead > firstPart) {
    memcpy(dst + firstPart, rb.data, toRead - firstPart);
  }
  rb.tail = (rb.tail + toRead) % rb.capacity;
  rb.count -= toRead;
  return toRead;
}

static uint16_t streamReadLE16(WiFiClient &s, bool &ok) {
  uint8_t b[2];
  int n = s.readBytes(b, 2);
  ok = ok && (n == 2);
  return (uint16_t)(b[0] | (b[1] << 8));
}

static uint32_t streamReadLE32(WiFiClient &s, bool &ok) {
  uint8_t b[4];
  int n = s.readBytes(b, 4);
  ok = ok && (n == 4);
  return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

// Discards `count` bytes from the stream by reading and dropping them --
// the streaming equivalent of the old File-based parser's f.seek() past
// an unknown chunk. A live network stream can't seek (bytes not yet
// arrived don't exist yet to skip to, and bytes already consumed can't
// be un-read), so unknown chunks between "fmt " and "data" (LIST/INFO/
// fact/etc, same as the old parser handled) are read into a small scratch
// buffer and thrown away instead.
static bool streamDiscard(WiFiClient &s, uint32_t count, unsigned long deadlineMs) {
  uint8_t scratch[64];
  while (count > 0) {
    if (millis() > deadlineMs) return false;
    if (!s.connected() && !s.available()) return false;
    if (s.available()) {
      int n = s.readBytes(scratch, min((uint32_t)sizeof(scratch), count));
      if (n <= 0) return false;
      count -= n;
    } else {
      delay(2);
    }
  }
  return true;
}

// Parses the RIFF/WAVE/fmt/data header directly off the live HTTP body
// stream, sequentially -- same chunk-walking logic and validation rules
// as the previous File-based parseWavHeader() (PCM=1 only, 8/16/24/32-bit
// only, tolerates a LIST/INFO/fact chunk between fmt and data), adapted
// to a forward-only stream. Stops the instant the "data" chunk header is
// found, with the stream positioned exactly at the first PCM byte --
// nothing here reads ahead into the audio payload itself, which
// streamPlayResponse() below consumes progressively via the ring buffer.
// Waits until at least one byte is available to read, or gives up on
// disconnect/deadline/a 10s no-data stall. Plain helper functions (not
// lambdas) to match this file's existing style.
static bool streamWaitByte(WiFiClient &s, unsigned long deadlineMs) {
  unsigned long waitStart = millis();
  while (!s.available()) {
    if (!s.connected() || millis() > deadlineMs) return false;
    if (millis() - waitStart > 10000) return false; // no header bytes at all for 10s -- treat as stalled
    delay(2);
  }
  return true;
}

static bool streamReadTag(WiFiClient &s, char *t) {
  int n = s.readBytes((uint8_t *)t, 4);
  return n == 4;
}

static bool parseWavHeaderStream(WiFiClient &s, WavInfo &info, unsigned long deadlineMs) {
  bool ok = true;
  char tag[4];

  if (!streamWaitByte(s, deadlineMs) || !streamReadTag(s, tag) || memcmp(tag, "RIFF", 4) != 0) {
    Serial.println("WAV parse error: missing RIFF header.");
    return false;
  }
  streamReadLE32(s, ok); // overall RIFF chunk size — not needed, dataSize from the data chunk is authoritative

  if (!streamWaitByte(s, deadlineMs) || !streamReadTag(s, tag) || memcmp(tag, "WAVE", 4) != 0) {
    Serial.println("WAV parse error: missing WAVE marker.");
    return false;
  }

  bool haveFmt = false, haveData = false;
  int guard = 0; // bounds the chunk-walk loop -- a malformed stream that never produces a valid "data" tag must not spin forever
  while (!haveData && guard++ < 32) {
    if (!streamWaitByte(s, deadlineMs) || !streamReadTag(s, tag)) {
      Serial.println("WAV parse error: stream ended before data chunk.");
      return false;
    }
    uint32_t chunkSize = streamReadLE32(s, ok);
    if (!ok) { Serial.println("WAV parse error: truncated chunk header."); return false; }

    if (memcmp(tag, "fmt ", 4) == 0) {
      info.audioFormat = streamReadLE16(s, ok);
      info.numChannels = streamReadLE16(s, ok);
      info.sampleRate = streamReadLE32(s, ok);
      streamReadLE32(s, ok); // byte rate — derivable, not needed directly
      streamReadLE16(s, ok); // block align — derivable, not needed directly
      info.bitsPerSample = streamReadLE16(s, ok);
      if (!ok) { Serial.println("WAV parse error: truncated fmt chunk."); return false; }
      // fmt chunk is nominally 16 bytes for PCM; some encoders pad it --
      // discard anything beyond the 16 bytes already read, same
      // word-alignment rule as every other chunk.
      uint32_t fmtRead = 16;
      if (chunkSize > fmtRead) {
        if (!streamDiscard(s, chunkSize - fmtRead + (chunkSize % 2), deadlineMs)) return false;
      } else if (chunkSize % 2) {
        if (!streamDiscard(s, 1, deadlineMs)) return false;
      }
      haveFmt = true;
    } else if (memcmp(tag, "data", 4) == 0) {
      info.dataSize = chunkSize;
      haveData = true; // stream is now positioned exactly at the first PCM byte -- caller reads audio from here
    } else {
      // Unknown chunk (LIST/INFO/fact/etc) — discard its body, word-aligned.
      if (!streamDiscard(s, chunkSize + (chunkSize % 2), deadlineMs)) return false;
    }
  }

  if (!haveFmt || !haveData) {
    Serial.println("WAV parse error: missing fmt or data chunk.");
    return false;
  }
  if (info.audioFormat != 1) {
    Serial.printf("WAV parse error: unsupported audioFormat=%u (only PCM=1 is supported).\n", info.audioFormat);
    return false;
  }
  if (info.bitsPerSample != 8 && info.bitsPerSample != 16 && info.bitsPerSample != 24 && info.bitsPerSample != 32) {
    Serial.printf("WAV parse error: unsupported bitsPerSample=%u.\n", info.bitsPerSample);
    return false;
  }

  Serial.println("WAV:");
  Serial.printf("  channels=%u\n", info.numChannels);
  Serial.printf("  sampleRate=%u\n", info.sampleRate);
  Serial.printf("  bits=%u\n", info.bitsPerSample);
  Serial.printf("  dataSize=%u (hint; actual end is determined by stream end, not this field)\n", info.dataSize);
  return true;
}

// Writes exactly `len` bytes from `data` to I2S, looping on partial
// writes and never discarding unwritten bytes -- i2s_write()'s own
// timeout parameter means a call CAN legitimately return having written
// fewer bytes than requested (DMA queue temporarily full), and the
// previous version of this code silently assumed the full count was
// always written. Returns false only on a real error/timeout with zero
// progress, not on ordinary partial writes (those just loop and
// continue).
static bool i2sWriteAllRetry(const uint8_t *data, size_t len) {
  size_t sent = 0;
  unsigned long lastProgress = millis();
  while (sent < len) {
    size_t bytesWritten = 0;
    esp_err_t err = i2s_write(I2S_NUM_0, data + sent, len - sent, &bytesWritten, 100 / portTICK_PERIOD_MS);
    if (err != ESP_OK) {
      Serial.printf("[PLAYBACK_ERROR] i2s_write error %d at offset %u/%u\n", err, (unsigned)sent, (unsigned)len);
      return false;
    }
    if (bytesWritten > 0) {
      sent += bytesWritten;
      lastProgress = millis();
    } else if (millis() - lastProgress > 5000) {
      // i2s_write() returned ESP_OK but wrote 0 bytes repeatedly for 5s
      // straight -- the DMA queue is stuck, not just momentarily full.
      Serial.println("[PLAYBACK_ERROR] i2s_write stalled with zero progress.");
      return false;
    }
    // no delay() here: i2s_write()'s own portTICK timeout already yields:
    // a tight retry loop would only add latency to real-time audio
  }
  return true;
}

// The core streaming loop: parses the WAV header directly off the
// already-connected HTTPClient's stream, then alternates filling the
// ring buffer from the network and draining it to I2S until the stream
// ends. Never writes the response to LittleFS. Returns false (and
// leaves I2S torn down) on any error -- per the requirement, corrupted
// or incomplete data is never played.
bool streamPlayResponse(HTTPClient &http) {
  // Content-Length, as HTTPClient itself parsed it from the response
  // headers -- confirmed live against the real voice-fetch endpoint (a
  // curl request for the same-sized WAV that triggered a real-hardware
  // stall received the FULL body correctly, with a matching
  // Content-Length header, ruling out the backend sending a short body).
  // Logged here explicitly so a stall's Serial output shows the
  // authoritative expected total right next to how many bytes actually
  // arrived, rather than requiring a second test to establish it.
  int contentLength = http.getSize();
  Serial.printf("[STREAM] Content-Length: %d\n", contentLength);

  WiFiClient *rawStream = http.getStreamPtr();
  if (!rawStream) {
    Serial.println("[PLAYBACK_ERROR] no response stream available.");
    return false;
  }

  unsigned long deadlineMs = millis() + 60000UL; // overall ceiling for header parse + full playback -- generous for a long reply's audio duration, but still bounded so a stalled connection can't hang forever
  WavInfo info;
  if (!parseWavHeaderStream(*rawStream, info, deadlineMs)) {
    Serial.println("[PLAYBACK_ERROR] WAV header parse failed.");
    return false;
  }
  Serial.println("[PLAY] WAV header parsed, starting streaming playback");

  // expectedBytes is the audio PAYLOAD portion of the body only (the WAV
  // header bytes parseWavHeaderStream() just consumed are not part of
  // what streamPlayResponse()'s own network-read counters track below).
  // Falls back to the WAV header's own dataSize field if Content-Length
  // wasn't available for some reason, so this diagnostic still has a
  // number to compare against either way.
  long expectedBytes = (contentLength > 0) ? (long)contentLength - 44 : (long)info.dataSize;
  Serial.printf("[STREAM] expected body bytes: %ld (Content-Length=%d, dataSize hint=%u)\n",
                expectedBytes, contentLength, (unsigned)info.dataSize);

  if (info.numChannels >= 2) {
    Serial.println("Note: stereo WAV — playing as interleaved stereo via I2S_CHANNEL_FMT_RIGHT_LEFT, no downmix needed.");
  }

  // Ring buffer lives in static storage, not the stack -- AUDIO_RINGBUF_BYTES
  // (32KB) would overflow this task's stack if it were a local array.
  static uint8_t ringStorage[AUDIO_RINGBUF_BYTES];
  RingBuffer rb;
  ringInit(rb, ringStorage, sizeof(ringStorage));

  // ---- pre-buffer phase: fill before starting I2S at all ----
  // A short stall right as playback starts is the worst time for one --
  // there's no accumulated buffer yet to absorb it. Filling
  // AUDIO_PREBUFFER_BYTES first (~0.5s of audio at this project's
  // 16kHz/16-bit/mono format) gives real headroom before the drain side
  // ever starts pulling from the buffer.
  uint8_t netChunk[512];
  unsigned long prebufferDeadline = millis() + 15000UL; // don't wait forever if the stream is unexpectedly short or slow
  while (rb.count < AUDIO_PREBUFFER_BYTES) {
    if (millis() > prebufferDeadline) break; // proceed with whatever we have rather than fail outright -- a short reply may never reach the full prebuffer target
    int availableNow = rawStream->available();
    if (!rawStream->connected() && availableNow <= 0) break; // stream already ended -- short clip, nothing wrong
    if (availableNow > 0) {
      int n = rawStream->readBytes(netChunk, min(sizeof(netChunk), (size_t)availableNow));
      if (n > 0) ringWrite(rb, netChunk, n);
    } else {
      delay(2);
    }
  }

  if (rb.count == 0) {
    Serial.println("[PLAYBACK_ERROR] no audio data received.");
    return false;
  }

  Serial.printf("[PLAY] Pre-buffered %u bytes, starting I2S\n", (unsigned)rb.count);
  i2sConfigureTx(info.sampleRate, info.bitsPerSample, info.numChannels);

  // ---- steady-state: fill from network, drain to I2S, interleaved ----
  //
  // Diagnostic instrumentation added after a real-hardware stall report:
  // pre-buffer (16594 bytes, ~0.5s of audio) succeeded, I2S was
  // configured, playback started, then BOTH sides reported zero progress
  // for a full 15s -- with no visibility into which side (network fill,
  // I2S drain, or something in between) actually stopped making progress
  // first, or why. The single shared lastAnyProgress timestamp made it
  // impossible to tell "network stopped delivering" apart from "I2S
  // stopped draining" apart from "both were fine but the loop itself
  // never reached them". This rewrite tracks network and I2S progress
  // SEPARATELY, logs a distinct state on every iteration where nothing
  // happened (rate-limited to avoid flooding Serial), and logs whichever
  // specific condition actually trips the stall timeout -- so the next
  // real-hardware run pinpoints the failure instead of restating that one
  // occurred.
  const size_t I2S_CHUNK = 512;
  uint8_t i2sChunk[I2S_CHUNK];
  bool streamEnded = false;
  bool playbackError = false;
  unsigned long lastNetworkProgress = millis();
  unsigned long lastI2sProgress = millis();
  uint32_t totalNetworkBytes = rb.count; // pre-buffer already counted
  uint32_t totalI2sBytes = 0;
  unsigned long lastStatusLog = millis();
  const unsigned long STATUS_LOG_INTERVAL_MS = 1000; // rate-limited per explicit instruction -- not per byte, not per iteration
  unsigned long lastRecoveryFailLog = 0;
  uint32_t recoveryFailStreak = 0; // consecutive fully-failed recovery bursts, reset on any successful recovery

  while (true) {
    unsigned long loopNow = millis();
    const char *fillState = "SKIPPED_STREAM_ENDED";
    const char *drainState = "SKIPPED_EMPTY";

    // Fill: pull whatever is available from the network into the ring
    // buffer without blocking, bounded by remaining ring capacity.
    if (!streamEnded) {
      bool stillConnected = rawStream->connected();
      int availableNow = rawStream->available();

      // ---- TLS read recovery ----
      // Root cause (confirmed against the real installed
      // NetworkClientSecure/ssl_client.cpp on this machine, core 3.3.7,
      // and matching a previously-reported defect, espressif/
      // arduino-esp32#942): WiFiClientSecure::available() is backed by
      // data_to_read(), which calls mbedtls_ssl_read(ctx, NULL, 0) -- a
      // zero-length probe that asks mbedTLS to check the socket for a
      // new complete TLS record and report mbedtls_ssl_get_bytes_avail()
      // afterward. read()/readBytes() are pure wrappers that hard-return
      // immediately if available() <= 0 (confirmed at
      // NetworkClientSecure.cpp:271-275) -- they never themselves attempt
      // a fresh socket read, and there is no public API on this class to
      // reach the underlying sslclient_context and force one directly
      // (it is a protected member; read()/available()/peek() are the
      // only public entry points). The ONLY lever available from calling
      // code is retrying available() itself and giving the WiFi stack's
      // own background processing real wall-clock time to actually
      // deliver the next TLS record before probing again.
      //
      // On real hardware, this stalled with the ring buffer already
      // EMPTY (nothing left to drain) immediately after I2S playback
      // started -- meaning the main loop's own delay(1) plus whatever
      // time i2s_write() spends blocked inside the DMA queue (I2S paces
      // at the real playback sample rate, not CPU speed) was otherwise
      // the only place WiFi got scheduled between fill attempts. This
      // recovery burst runs a SHORT bounded number of extra available()
      // probes, each preceded by its own short delay(), specifically at
      // the moment fill has nothing to do -- giving WiFi additional
      // scheduling windows beyond the one main-loop iteration, without
      // ever blocking indefinitely (bounded retry count + bounded delay
      // per retry, decided up front, no loop that can spin forever).
      if (availableNow <= 0 && stillConnected && expectedBytes > 0 &&
          (long)totalNetworkBytes < expectedBytes) {
        const int RECOVERY_ATTEMPTS = 5;
        const unsigned long RECOVERY_DELAY_MS = 10;
        for (int attempt = 1; attempt <= RECOVERY_ATTEMPTS && availableNow <= 0; attempt++) {
          delay(RECOVERY_DELAY_MS); // yields to the scheduler -- Arduino's delay() calls vTaskDelay() internally, giving WiFi's own task a real window to run
          availableNow = rawStream->available();
          if (availableNow <= 0 && !rawStream->connected()) {
            stillConnected = false;
            break; // connection dropped mid-recovery -- stop retrying, fall through to the disconnect handling below
          }
        }
        if (availableNow > 0) {
          Serial.printf("[STREAM] TLS read recovery received data after retry (available=%d)\n", availableNow);
          recoveryFailStreak = 0;
        } else {
          // Repeated-failure logging is rate-limited to once per second
          // (its own timestamp, independent of the general status line's
          // schedule) rather than once per failed burst -- a genuinely
          // stuck stream would otherwise log this every ~50ms (5 attempts
          // * 10ms), which is exactly the Serial-flooding this firmware's
          // diagnostics have deliberately avoided everywhere else.
          recoveryFailStreak++;
          if (loopNow - lastRecoveryFailLog >= 1000) {
            Serial.printf("[STREAM] TLS read recovery attempt failed (streak=%u, remainingExpected=%ld)\n",
                          (unsigned)recoveryFailStreak, expectedBytes - (long)totalNetworkBytes);
            lastRecoveryFailLog = loopNow;
          }
        }
      }

      if (availableNow > 0) {
        size_t room = ringFree(rb);
        if (room > 0) {
          size_t want = min(room, (size_t)availableNow);
          want = min(want, sizeof(netChunk));
          int n = rawStream->readBytes(netChunk, want);
          if (n > 0) {
            ringWrite(rb, netChunk, n);
            lastNetworkProgress = loopNow;
            totalNetworkBytes += n;
            fillState = "NETWORK_READ";
          } else {
            // available() reported >0 but readBytes() returned 0 -- a
            // real, distinguishable condition (per the requirement not
            // to treat every zero-progress case the same way): the
            // socket claimed data was ready but the read itself produced
            // nothing this call.
            fillState = "NETWORK_READ_ZERO";
          }
        } else {
          fillState = "BUFFER_FULL"; // network has data, but the ring buffer has no room -- I2S drain is the bottleneck, not the network
        }
      } else if (!stillConnected) {
        streamEnded = true; // connection closed -- this is the authoritative end-of-audio signal, not the WAV header's dataSize field
        fillState = "TCP_DISCONNECTED";
      } else {
        fillState = "NETWORK_WAIT"; // still connected, simply nothing available from the socket THIS iteration (even after the recovery burst above) -- normal and expected between TCP segments, not itself an error
      }
    }

    // ---- Content-Length-based completion check ----
    // Real-hardware result: netBytes reached expectedBytes exactly
    // (702806 == 702806) and every byte was drained to I2S
    // (i2sBytes == netBytes, ringCount == 0) -- yet the loop kept running
    // and eventually hit STALL_TIMEOUT, because the only completion path
    // was `else if (streamEnded)` below, and streamEnded is ONLY ever set
    // by an actual TCP disconnect (fillState == TCP_DISCONNECTED, a few
    // lines up). voice-fetch's connection can stay open/keep-alive after
    // the full body has already been delivered -- there is no requirement
    // that the server close the socket just because this was its only
    // response on it, and per the explicit instruction, this firmware
    // must not wait for that to happen. Content-Length (expectedBytes,
    // added in 76da09e) is the authoritative signal for "the body is
    // fully received"; it does not need TCP-level confirmation on top of
    // that. This check is evaluated every iteration, independent of
    // streamEnded, and completes playback the instant all three
    // conditions are simultaneously true: the full expected byte count
    // has arrived from the network, every one of those bytes has already
    // been drained out through I2S, and the ring buffer is empty (so
    // there is nothing left in flight that this check could be
    // prematurely cutting off).
    if (!playbackError && expectedBytes > 0 &&
        (long)totalNetworkBytes >= expectedBytes &&
        (long)totalI2sBytes >= expectedBytes &&
        rb.count == 0) {
      Serial.println("[PLAY] HTTP body fully consumed");
      Serial.println("[PLAY] All audio drained to I2S");
      Serial.printf("[PLAY] Streaming playback complete (netBytes=%u i2sBytes=%u expectedBytes=%ld)\n",
                    (unsigned)totalNetworkBytes, (unsigned)totalI2sBytes, expectedBytes);
      break; // success -- falls through to the existing silence-pad + i2sTeardown() below, same as any other clean completion
    }

    // Drain: hand off one I2S-sized chunk from the ring buffer, if any
    // is available.
    if (rb.count > 0) {
      // ringRead() itself already clamps to whatever's actually available
      // (min(len, rb.count) internally), so simply requesting up to a
      // full I2S_CHUNK here is correct and avoids comparing against the
      // volatile rb.count field directly at this call site.
      size_t n = ringRead(rb, i2sChunk, I2S_CHUNK);
      if (!i2sWriteAllRetry(i2sChunk, n)) {
        playbackError = true;
        drainState = "I2S_WRITE_ERROR";
        Serial.printf("[STREAM] state=%s netBytes=%u i2sBytes=%u ringCount=%u ringCap=%u connected=%d\n",
                      drainState, (unsigned)totalNetworkBytes, (unsigned)totalI2sBytes, (unsigned)rb.count, (unsigned)rb.capacity, (int)rawStream->connected());
        break;
      }
      lastI2sProgress = loopNow;
      totalI2sBytes += n;
      drainState = "I2S_WRITE";
    } else if (streamEnded) {
      // Per the explicit requirement: the response is only genuinely
      // complete if the bytes actually received match what Content-Length
      // promised. A TCP disconnect after fewer bytes than expected is a
      // TRUNCATED response, not a normal completion -- logged distinctly
      // here (SHORT vs COMPLETE) so this is provable from the Serial
      // output rather than inferred.
      long remainingExpectedBytes = expectedBytes - (long)totalNetworkBytes;
      bool wasShort = (expectedBytes > 0) && (remainingExpectedBytes > 0);
      Serial.printf("[STREAM] state=END_OF_STREAM (%s) netBytes=%u i2sBytes=%u expectedBytes=%ld remainingExpectedBytes=%ld\n",
                    wasShort ? "SHORT" : "COMPLETE",
                    (unsigned)totalNetworkBytes, (unsigned)totalI2sBytes, expectedBytes, remainingExpectedBytes);
      if (wasShort) playbackError = true; // per the requirement -- do not treat an early TCP close as a valid completion when bytes are still missing
      break; // buffer empty AND network stream is done -- playback complete (or truncated, per the flag above)
    } else {
      drainState = "BUFFER_EMPTY"; // nothing queued for I2S yet -- normal while waiting on the network to fill it, not itself an error
    }

    // Rate-limited status line -- every ~1s, not every iteration/byte,
    // per the explicit requirement. Reports exactly the fields asked
    // for: ring capacity, current buffered bytes, cumulative bytes moved
    // each direction, both progress timestamps (as "ms since"), and live
    // connection state.
    if (loopNow - lastStatusLog >= STATUS_LOG_INTERVAL_MS) {
      Serial.printf("[STREAM] fill=%s drain=%s ringCount=%u/%u netBytes=%u i2sBytes=%u remainingExpected=%ld sinceNet=%lums sinceI2s=%lums connected=%d\n",
                    fillState, drainState, (unsigned)rb.count, (unsigned)rb.capacity,
                    (unsigned)totalNetworkBytes, (unsigned)totalI2sBytes,
                    expectedBytes - (long)totalNetworkBytes,
                    loopNow - lastNetworkProgress, loopNow - lastI2sProgress,
                    (int)rawStream->connected());
      lastStatusLog = loopNow;
    }

    // Stall detection: only fires when NEITHER side has made real
    // progress in 15s. Logs which specific side(s) are stuck so a stall
    // caused by "network genuinely has nothing new" reads differently
    // from "I2S stopped accepting writes" -- collapsing both into one
    // generic message (the previous version) is exactly what made this
    // report undiagnosable from the log alone.
    bool networkStalled = (loopNow - lastNetworkProgress) > 15000;
    bool i2sStalled = (loopNow - lastI2sProgress) > 15000;
    if (networkStalled && i2sStalled) {
      Serial.printf("[PLAYBACK_ERROR] STALL_TIMEOUT: network idle %lums, I2S idle %lums, ringCount=%u/%u, netBytes=%u, i2sBytes=%u, expectedBytes=%ld, remainingExpectedBytes=%ld, tcpConnected=%d\n",
                    loopNow - lastNetworkProgress, loopNow - lastI2sProgress,
                    (unsigned)rb.count, (unsigned)rb.capacity,
                    (unsigned)totalNetworkBytes, (unsigned)totalI2sBytes,
                    expectedBytes, expectedBytes - (long)totalNetworkBytes,
                    (int)rawStream->connected());
      playbackError = true;
      break;
    }

    delay(1);
  }

  // Same reasoning as the previous fixed-delay drain fix, now applied
  // after a variable-length stream instead of a known-length file: write
  // ~200ms of silence through i2s_write() itself after the real audio so
  // the DMA queue is guaranteed to have actually drained (I2S/DMA
  // delivers samples in strict FIFO order) before i2sTeardown() runs,
  // rather than relying on a bare delay() estimate.
  if (!playbackError) {
    uint16_t bytesPerSample = (info.bitsPerSample / 8) * (info.numChannels >= 2 ? 2 : 1);
    uint32_t silenceBytes = (info.sampleRate * bytesPerSample * 200) / 1000;
    static uint8_t silenceBuf[512] = {0};
    uint32_t silenceRemaining = silenceBytes;
    while (silenceRemaining > 0) {
      size_t n = min((uint32_t)sizeof(silenceBuf), silenceRemaining);
      if (!i2sWriteAllRetry(silenceBuf, n)) break; // best-effort -- a failure here doesn't invalidate audio that already played correctly
      silenceRemaining -= n;
    }
    delay(50);
  }

  i2sTeardown();

  if (playbackError) {
    Serial.println("[PLAYBACK_ERROR] streaming playback failed.");
    return false;
  }
  Serial.println("[PLAY] Finished (streamed, never written to LittleFS)");
  return true;
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

  // Disable WiFi modem sleep. The ESP32 enables WIFI_PS_MIN_MODEM by
  // default in station mode: the radio sleeps between the AP's beacon
  // intervals (~100ms) and only wakes to collect buffered traffic. That
  // is fine for request/response traffic, but it throttles a sustained
  // download into bursts separated by sleep intervals -- and this
  // firmware streams audio in real time, where the I2S side drains at a
  // fixed 32000 bytes/sec (16kHz/16-bit/mono) and cannot wait.
  //
  // The failure this fixes is specific to the idle replay path
  // (checkForQueuedAudio, triggered by the dashboard's per-message
  // speaker button): after minutes in ST_IDLE with only tiny 3s
  // 204-polls, the radio settles into its sleep duty cycle, so when a
  // real WAV body finally arrives it trickles in slower than playback
  // consumes it. Once the AUDIO_PREBUFFER_BYTES cushion (~0.5s) is
  // spent, the ring buffer underruns and I2S -- which never pauses --
  // emits choppy/distorted audio. The post-upload path did not show this
  // because a ~135KB TLS upload immediately beforehand keeps the radio
  // continuously awake, so the stream arrives at full speed.
  //
  // Kept fully awake rather than tuned, because this terminal is
  // mains-powered and must be ready to receive a queued clip at any
  // moment; modem-sleep's power saving only matters on battery.
  WiFi.setSleep(false);

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