/**
 * Lecture capture — merekam mikrofon sebagai PCM mentah (FR-05).
 *
 * Kenapa bukan `MediaRecorder`:
 *
 * Chunk timeslice `MediaRecorder` **tidak bisa didekode sendiri**. Hanya
 * chunk pertama yang membawa header container (magic `1A45DFA3` untuk
 * WebM); chunk berikutnya mulai di tengah container dan `ffmpeg` gagal
 * memuatnya. Menempelkan header chunk 0 ke chunk N membuatnya *ter-decode*,
 * tapi audionya tidak cocok dengan ground truth — transkripsinya ngawur.
 *
 * PCM mentah bebas container: tiap potongan berdiri sendiri, dan cukup
 * dibungkus header WAV 44 byte di server untuk dibaca Whisper.
 *
 * Jalur `MediaRecorder` tetap dipertahankan sebagai **fallback** — kalau
 * `AudioWorklet` tidak tersedia (browser lama, atau konteks audio tidak
 * bisa dibuat), rekaman tetap bisa diselesaikan lewat jalur unggah penuh
 * yang sudah ada sejak dulu. Tidak ada regresi.
 *
 * Antarmuka modul ini:
 *
 *   const capture = await LectureCapture.create({ chunkSeconds: 4 });
 *   capture.on("chunk", ({ seq, pcm, rate }) => { ... });
 *   capture.on("error", (error) => { ... });
 *   capture.start();
 *   capture.stop();      // -> Promise<{ mode, blob?, filename? }>
 */
(function (global) {
  "use strict";

  const DEFAULT_CHUNK_SECONDS = 4;
  const DEFAULT_RATE = 16000;

  // Worklet yang mengumpulkan sample Float32 lalu memancarkannya mentah.
  //
  // `process()` dipanggil per quantum audio (128 frame). Sample diaccumulate
  // sampai jumlahnya cukup untuk satu potongan, lalu dikirim lewat port.
  //
  // Yang dikirim masih **Float32** (bukan Int16): downsampling ke 16 kHz
  // harus terjadi di thread utama, karena rate perangkat bisa berbeda dari
  // 16 kHz dan konversinya tidak bisa dilakukan di dalam worklet tanpa
  // menambah kompleksitasnya.
  const WORKLET_SOURCE = `
    class PcmCaptureProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.chunkFrames = options.processorOptions.chunkFrames;
        this.buffer = new Float32Array(this.chunkFrames);
        this.filled = 0;
        this.stopped = false;
        this.port.onmessage = (event) => {
          if (event.data === "stop") this.stopped = true;
        };
      }

      process(inputs) {
        if (this.stopped) return false;

        const input = inputs[0];
        if (!input || !input.length) return true;

        const channel = input[0];
        if (!channel) return true;

        let offset = 0;

        while (offset < channel.length) {
          const space = this.chunkFrames - this.filled;
          const take = Math.min(space, channel.length - offset);

          this.buffer.set(channel.subarray(offset, offset + take), this.filled);
          this.filled += take;
          offset += take;

          if (this.filled >= this.chunkFrames) {
            // Buffer dialihkan supaya bisa di-transfer tanpa copy.
            const out = this.buffer;
            this.buffer = new Float32Array(this.chunkFrames);
            this.filled = 0;
            this.port.postMessage(out.buffer, [out.buffer]);
          }
        }

        return true;
      }
    }

    registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
  `;

  /**
   * Turunkan sample rate ke target dengan interpolasi linear.
   *
   * Dipakai kalau `AudioContext` menolak dibuat dengan rate 16 kHz
   * (beberapa perangkat membatasi). Round-trip ini mengubah pitch kalau
   * rasionya bukan bilangan bulat, tapi untuk rekaman kuliah errornya
   * jauh lebih kecil daripada kehilangan fitur live.
   */
  function downsample(input, inputRate, targetRate) {
    if (inputRate === targetRate) return input;

    const ratio = inputRate / targetRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      const index = Math.floor(position);
      const frac = position - index;

      const a = input[index] || 0;
      const b = input[index + 1] !== undefined ? input[index + 1] : a;

      output[i] = a + (b - a) * frac;
    }

    return output;
  }

  /** Float32 -> Int16 mentah (PCM 16-bit little-endian). */
  function floatToInt16(input) {
    const output = new Int16Array(input.length);

    for (let i = 0; i < input.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    return output;
  }

  class LectureCapture {
    constructor() {
      this.mode = "pcm";
      this.rate = DEFAULT_RATE;
      this.targetRate = DEFAULT_RATE;
      this.chunkSeconds = DEFAULT_CHUNK_SECONDS;
      this.context = null;
      this.stream = null;
      this.source = null;
      this.worklet = null;
      this.mediaRecorder = null;
      this.mediaChunks = [];
      this.seq = 0;
      this.active = false;
      this.listeners = { chunk: [], error: [], mode: [] };
    }

    /**
     * Buat capture yang sudah siap merekam.
     *
     * `AudioWorklet` diuji lebih dulu; kalau tidak tersedia, mode turun ke
     * `"mediatracer"` dan pemanggil memakai jalur unggah penuh.
     */
    static async create(options = {}) {
      const capture = new LectureCapture();
      capture.chunkSeconds = options.chunkSeconds || DEFAULT_CHUNK_SECONDS;

      await capture._prepare(options);
      return capture;
    }

    async _prepare(options) {
      const wantsMic = options.audio !== false;

      if (wantsMic && !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Browser ini tidak mendukung perekaman mikrofon.");
      }

      if (!wantsMic) {
        this.mode = "mediatracer";
        return;
      }

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      if (!global.AudioWorkletNode || !global.AudioContext) {
        // Fallback: MediaRecorder. Caller yang menangani hasilnya.
        this.mode = "mediatracer";
        return;
      }

      const targetRate = options.rate || DEFAULT_RATE;
      this.targetRate = targetRate;

      try {
        this.context = new AudioContext({ sampleRate: targetRate });
      } catch {
        this.context = new AudioContext();
      }

      // Rate devices mungkin berbeda dari 16 kHz (mis. 48 kHz). Konteks
      // memberi rate aslinya; sample di-downsample ke ``targetRate`` di
      // thread utama sebelum dikirim.
      this.rate = this.context.sampleRate;

      try {
        const blob = new Blob([WORKLET_SOURCE], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);

        try {
          await this.context.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        // AudioWorklet gagal dimuat — pakai MediaRecorder.
        await this._closeContext();
        this.mode = "mediatracer";
        this._error = error;
        return;
      }

      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, "pcm-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          chunkFrames: Math.max(
            1024,
            Math.round(this.rate * this.chunkSeconds),
          ),
        },
      });

      this.worklet.port.onmessage = (event) => {
        // Worklet mengirim Float32 mentah; konversi ke PCM 16-bit
        // dilakukan di sini, di thread utama.
        const samples = new Float32Array(event.data);

        const resampled =
          this.rate === this.targetRate
            ? samples
            : downsample(samples, this.rate, this.targetRate);

        this._emit("chunk", {
          seq: this.seq,
          pcm: floatToInt16(resampled),
          rate: this.targetRate,
        });
        this.seq += 1;
      };
    }

    on(event, handler) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(handler);
      return this;
    }

    _emit(event, payload) {
      (this.listeners[event] || []).forEach((handler) => {
        try {
          handler(payload);
        } catch (error) {
          console.error("[lecture-capture] handler gagal:", error);
        }
      });
    }

    start() {
      if (this.active) return;
      this.active = true;

      if (this.mode === "mediatracer") {
        this._startMediaRecorder();
        return;
      }

      this.context.resume?.();

      // Worklet butuh disambungkan ke output supaya grafik audio ikut
      // berjalan. Outputnya dibuang — yang kita mau hanya prosesnya.
      const silent = this.context.createGain();
      silent.gain.value = 0;
      this.source.connect(this.worklet);
      this.worklet.connect(silent);
      silent.connect(this.context.destination);
    }

    _startMediaRecorder() {
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((candidate) => MediaRecorder.isTypeSupported?.(candidate));

      try {
        this.mediaRecorder = new MediaRecorder(
          this.stream,
          mimeType ? { mimeType } : undefined,
        );
      } catch {
        this.mediaRecorder = new MediaRecorder(this.stream);
      }

      this.mediaChunks = [];
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) this.mediaChunks.push(event.data);
      };
      this.mediaRecorder.start(1000);
    }

    /**
     * Hentikan rekaman.
     *
     * Untuk mode PCM hasilnya bukan blob — pemanggil sudah menerima
     * tiap potongan lewat event `"chunk"`. Yang dikembalikan di sini
     * hanya informasi mode supaya pemanggil tahu harus lewat jalur
     * mana.
     */
    async stop() {
      if (!this.active) {
        return { mode: this.mode, blob: null, filename: "" };
      }

      this.active = false;

      if (this.mode === "mediatracer") {
        const blob = await this._stopMediaRecorder();
        return { mode: "mediatracer", blob, filename: this._filenameFor(blob) };
      }

      try {
        this.worklet?.port.postMessage("stop");
        this.source?.disconnect();
        this.worklet?.disconnect();
      } catch {
        // Node yang sudah terputus tidak apa-apa.
      }

      await this._closeContext();
      this._stopStream();

      return { mode: "pcm", blob: null, filename: "" };
    }

    async _stopMediaRecorder() {
      const recorder = this.mediaRecorder;

      if (!recorder) return null;

      const blob = await new Promise((resolve) => {
        recorder.onstop = () => {
          resolve(new Blob(this.mediaChunks, { type: recorder.mimeType }));
        };

        try {
          recorder.stop();
        } catch {
          resolve(null);
        }
      });

      this.mediaChunks = [];
      this._stopStream();
      return blob;
    }

    _filenameFor(blob) {
      const type = (blob?.type || "").toLowerCase();

      if (type.includes("webm")) return "rekaman.webm";
      if (type.includes("ogg")) return "rekaman.ogg";
      if (type.includes("mp4")) return "rekaman.m4a";
      if (type.includes("mpeg")) return "rekaman.mp3";
      if (type.includes("wav")) return "rekaman.wav";

      return "rekaman.webm";
    }

    async _closeContext() {
      if (!this.context) return;

      try {
        await this.context.close();
      } catch {
        // Konteks yang sudah tertutup tidak apa-apa.
      }

      this.context = null;
    }

    _stopStream() {
      if (!this.stream) return;

      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    /**
     * Konversi PCM mentah jadi bytes siap kirim.
     *
     * Dipisah dari event `"chunk"` supaya pemanggil bebas memutuskan mau
     * langsung mengirim atau menahannya di buffer offline dulu.
     */
    static toBytes(pcm) {
      if (pcm instanceof Int16Array) {
        return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      }
      if (pcm instanceof ArrayBuffer) {
        return new Uint8Array(pcm);
      }
      return new Uint8Array(pcm);
    }
  }

  // Utilitas yang kadang dipakai di luar: downsample + konversi Int16.
  LectureCapture.downsample = downsample;
  LectureCapture.floatToInt16 = floatToInt16;

  global.LectureCapture = LectureCapture;
})(window);
