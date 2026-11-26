/**
 * SENTINEL PRO WEB — Gestor Forense (Alarma Web Audio + DVR MediaRecorder + Fotos + CSV)
 */
(function (global) {
  class ForensicsManager {
    constructor(uiHooks) {
      this.ui = uiHooks;
      this.events = [];
      this.cooldowns = new Map();
      this.soundEnabled = true;
      this.lastBeep = 0;
      this.audioCtx = null;

      this.recording = false;
      this.manualDvr = false;
      this.autoStopAt = 0;
      this.recorder = null;
      this.chunks = [];
      this.clipCount = 0;
    }

    _playSiren() {
      if (!this.soundEnabled) return;
      const now = performance.now();
      if (now - this.lastBeep < 1600) return;
      this.lastBeep = now;

      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!this.audioCtx) this.audioCtx = new AudioCtx();
        if (this.audioCtx.state === "suspended") this.audioCtx.resume();

        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(1650, this.audioCtx.currentTime);
        osc.frequency.setValueAtTime(1250, this.audioCtx.currentTime + 0.14);
        gain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.30);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.31);
      } catch (_) {}
    }

    _captureCrop(canvas, box) {
      if (!box) return "";
      const pad = 22;
      const x1 = Math.max(0, Math.floor(box[0] - pad));
      const y1 = Math.max(0, Math.floor(box[1] - pad));
      const x2 = Math.min(canvas.width, Math.ceil(box[2] + pad));
      const y2 = Math.min(canvas.height, Math.ceil(box[3] + pad));
      const cw = x2 - x1;
      const ch = y2 - y1;
      if (cw < 16 || ch < 16) return "";

      const tmp = document.createElement("canvas");
      tmp.width = cw;
      tmp.height = ch;
      tmp.getContext("2d").drawImage(canvas, x1, y1, cw, ch, 0, 0, cw, ch);
      return tmp.toDataURL("image/jpeg", 0.88);
    }

    log(nivel, evento, detalles, canvas, cropBox, riesgo = 0, cooldownSec = 5.0) {
      const now = performance.now() / 1000;
      const key = `${nivel}:${evento}`;
      if (now - (this.cooldowns.get(key) || 0) < cooldownSec) return;
      this.cooldowns.set(key, now);

      const d = new Date();
      const hora = d.toTimeString().slice(0, 8);
      const fecha = d.toISOString().replace("T", " ").slice(0, 19);

      let fullUrl = "";
      let cropUrl = "";
      if (canvas && (nivel === "CRITICO" || nivel === "ALERTA")) {
        fullUrl = canvas.toDataURL("image/jpeg", 0.82);
        cropUrl = this._captureCrop(canvas, cropBox);
      }

      const rec = { fecha, hora, nivel, evento, detalles, riesgo, fullUrl, cropUrl };
      this.events.unshift(rec);
      if (this.events.length > 200) this.events.pop();

      if (this.ui && this.ui.onNewEvent) this.ui.onNewEvent(rec);
      if (nivel === "CRITICO") this._playSiren();
    }

    startDvr(canvas, manual = true) {
      if (this.recording) return;
      if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
        this.log("INFO", "DVR NO SOPORTADO", "Navegador sin MediaRecorder", null, null, 0, 2);
        return;
      }

      try {
        const stream = canvas.captureStream(20);
        const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
          .find((m) => MediaRecorder.isTypeSupported(m)) || "";

        this.chunks = [];
        this.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        this.recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        this.recorder.onstop = () => {
          if (!this.chunks.length) return;
          const blob = new Blob(this.chunks, { type: mime || "video/webm" });
          const url = URL.createObjectURL(blob);
          const ext = (mime || "").includes("mp4") ? "mp4" : "webm";
          this.clipCount++;
          const name = `dvr_${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${ext}`;
          if (this.ui && this.ui.onClipReady) this.ui.onClipReady(name, url, this.clipCount);
          this.log("INFO", "DVR GUARDADO", name, null, null, 0, 0.5);
        };

        this.recorder.start(500);
        this.recording = true;
        this.manualDvr = manual;
        this.autoStopAt = manual ? 0 : performance.now() / 1000 + 10.0;
        if (this.ui && this.ui.onDvrState) this.ui.onDvrState(true);
        this.log("INFO", "DVR INICIADO", manual ? "Manual" : "Auto-Alerta", null, null, 0, 0.5);
      } catch (err) {
        console.warn("[DVR ERROR]", err);
      }
    }

    stopDvr() {
      if (!this.recording) return;
      this.recording = false;
      this.manualDvr = false;
      this.autoStopAt = 0;
      if (this.recorder && this.recorder.state !== "inactive") {
        this.recorder.stop();
      }
      if (this.ui && this.ui.onDvrState) this.ui.onDvrState(false);
    }

    tickDvr(canvas, criticalAlert) {
      const now = performance.now() / 1000;
      if (criticalAlert) {
        this.autoStopAt = Math.max(this.autoStopAt, now + 10.0);
        if (!this.recording) this.startDvr(canvas, false);
      }
      if (this.recording && !this.manualDvr && this.autoStopAt > 0 && now > this.autoStopAt) {
        this.stopDvr();
      }
    }

    exportCsv() {
      const rows = [["FechaHora", "Nivel", "Evento", "Detalles", "Riesgo"]];
      for (const e of this.events) {
        rows.push([e.fecha, e.nivel, e.evento, e.detalles, e.riesgo]);
      }
      const csv = rows
        .map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sentinel_forense_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    }
  }

  global.SentinelForensics = ForensicsManager;
})(window);
