/**
 * SENTINEL PRO WEB — Motor IA en Navegador (TF.js WebGL + MoveNet MultiPose + ONNX Custom Opcional)
 */
(function (global) {
  const WORK_W = 640;
  const WORK_H = 360;

  // Etiquetas por defecto si el usuario carga un modelo YOLO .onnx de armas sin metadata
  const DEFAULT_ONNX_CLASSES = [
    "handgun", "knife", "pistol", "rifle", "shotgun", "machete", "helmet"
  ];

  class SentinelAIEngine {
    constructor() {
      this.objModel = null;
      this.poseDetector = null;
      this.onnxSession = null;
      this.onnxInputName = "images";
      this.onnxLabels = DEFAULT_ONNX_CLASSES;

      this.ready = false;
      this.busy = false;
      this.backend = "cpu";
      this.modeLabel = "CARGANDO";
      this.lastLatencyMs = 0;

      // Offscreen canvas para unificar coordenadas entre webcam/video, COCO-SSD, MoveNet y ONNX
      this.workCanvas = document.createElement("canvas");
      this.workCanvas.width = WORK_W;
      this.workCanvas.height = WORK_H;
      this.workCtx = this.workCanvas.getContext("2d", { willReadFrequently: true });

      // Offscreen 640x640 para inferencia ONNX YOLO opcional
      this.onnxCanvas = document.createElement("canvas");
      this.onnxCanvas.width = 640;
      this.onnxCanvas.height = 640;
      this.onnxCtx = this.onnxCanvas.getContext("2d", { willReadFrequently: true });
    }

    async init(onStatus) {
      const report = (msg) => { if (onStatus) onStatus(msg); };
      try {
        report("Inicializando aceleración GPU (WebGL)...");
        await tf.ready();
        try {
          await tf.setBackend("webgl");
        } catch (_) {
          await tf.setBackend("cpu");
        }
        this.backend = tf.getBackend().toUpperCase();

        report(`Cargando detector de objetos (${this.backend})...`);
        this.objModel = await cocoSsd.load({ base: "mobilenet_v2" });

        report("Cargando detector biomecánico MoveNet MultiPose...");
        this.poseDetector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          {
            modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
            enableTracking: true,
            trackerType: poseDetection.TrackerType.BoundingBox
          }
        );

        this.ready = true;
        this.modeLabel = `COCO+POSE (${this.backend})`;
        report(`LISTO | ${this.modeLabel}`);

        // Auto-cargar models/armas.onnx si existe en el repositorio GitHub Pages
        this._tryAutoLoadOnnx(report);
      } catch (err) {
        console.error("[AI INIT ERROR]", err);
        report("Error cargando IA: revisa tu conexión a internet.");
      }
    }

    async _tryAutoLoadOnnx(report) {
      if (typeof ort === "undefined") return;
      try {
        const res = await fetch("models/armas.onnx", { method: "HEAD" });
        if (res.ok) {
          const buf = await (await fetch("models/armas.onnx")).arrayBuffer();
          await this.loadOnnxWeaponModel(buf, "armas.onnx", report);
        }
      } catch (_) {
        // Silencioso: es opcional
      }
    }

    async loadOnnxWeaponModel(arrayBuffer, fileName, onStatus) {
      if (typeof ort === "undefined") {
        throw new Error("ONNX Runtime Web no disponible.");
      }
      if (onStatus) onStatus(`Cargando especialista ${fileName}...`);
      const session = await ort.InferenceSession.create(arrayBuffer, {
        executionProviders: ["wasm"]
      });
      this.onnxSession = session;
      this.onnxInputName = session.inputNames[0] || "images";
      this.modeLabel = `COCO+POSE+ONNX (${this.backend})`;
      if (onStatus) onStatus(`LISTO | ${this.modeLabel}`);
    }

    _classify(rawName, conf, box, uiW, uiH, source) {
      const bw = Math.max(1, box[2] - box[0]);
      const bh = Math.max(1, box[3] - box[1]);
      const areaRatio = (bw * bh) / (uiW * uiH);
      if (areaRatio > 0.88) return null;

      const n = String(rawName || "").toLowerCase().trim();
      if (n === "person") {
        return { grupo: "persona", label: "PERSONA", conf, box };
      }
      if (["handgun", "pistol", "revolver", "gun", "rifle", "shotgun", "firearm", "weapon"].some((k) => n.includes(k))) {
        if (areaRatio > 0.35 || conf < 0.28) return null;
        return { grupo: "arma_fuego", label: `ARMA FUEGO (${n.toUpperCase()})`, conf, box };
      }
      if (["knife", "machete", "scissors", "blade", "dagger"].some((k) => n.includes(k))) {
        if (areaRatio > 0.26 || conf < 0.28) return null;
        return { grupo: "arma_blanca", label: `ARMA BLANCA (${n.toUpperCase()})`, conf, box };
      }
      if (["baseball bat", "crowbar", "bat"].some((k) => n.includes(k))) {
        if (areaRatio > 0.35 || conf < 0.32) return null;
        return { grupo: "arma_contundente", label: "OBJ. CONTUNDENTE", conf, box };
      }
      if (["helmet", "hard hat"].some((k) => n.includes(k))) {
        return { grupo: "casco", label: "CASCO", conf, box };
      }
      if (["car", "truck", "bus"].includes(n)) {
        const tipo = n === "car" ? "AUTO" : "PESADO";
        return { grupo: "vehiculo", label: tipo, conf, box };
      }
      if (["motorcycle", "bicycle"].includes(n)) {
        const tipo = n === "motorcycle" ? "MOTO" : "BICICLETA";
        return { grupo: "moto", label: tipo, conf, box };
      }
      if (["backpack", "suitcase", "handbag"].includes(n)) {
        return { grupo: "bulto", label: "BULTO", conf, box };
      }
      // Si viene del modelo custom .onnx con etiqueta desconocida, tratar como arma
      if (source === "onnx" && conf >= 0.35) {
        return { grupo: "arma_fuego", label: `ARMA (${n.toUpperCase()})`, conf, box };
      }
      return null;
    }

    async _runOnnxYolo(minConf, uiW, uiH) {
      if (!this.onnxSession) return [];
      const size = 640;
      const ctx = this.onnxCtx;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, size, size);

      // Letterbox manteniendo relación 16:9 (640x360 centrado en 640x640)
      const scale = Math.min(size / WORK_W, size / WORK_H);
      const nw = Math.round(WORK_W * scale);
      const nh = Math.round(WORK_H * scale);
      const padX = Math.floor((size - nw) / 2);
      const padY = Math.floor((size - nh) / 2);
      ctx.drawImage(this.workCanvas, 0, 0, WORK_W, WORK_H, padX, padY, nw, nh);

      const imgData = ctx.getImageData(0, 0, size, size).data;
      const area = size * size;
      const floatData = new Float32Array(3 * area);
      for (let i = 0; i < area; i++) {
        const j = i * 4;
        floatData[i] = imgData[j] / 255.0;
        floatData[area + i] = imgData[j + 1] / 255.0;
        floatData[2 * area + i] = imgData[j + 2] / 255.0;
      }

      const tensor = new ort.Tensor("float32", floatData, [1, 3, size, size]);
      const outputs = await this.onnxSession.run({ [this.onnxInputName]: tensor });
      const out = outputs[this.onnxSession.outputNames[0]];
      const data = out.data;
      const dims = out.dims; // Típico YOLOv8/11: [1, 4+nc, 8400]

      const rawBoxes = [];
      const sx = uiW / WORK_W;
      const sy = uiH / WORK_H;

      if (dims.length === 3) {
        const channelsFirst = dims[1] < dims[2];
        const numAttrs = channelsFirst ? dims[1] : dims[2];
        const numAnchors = channelsFirst ? dims[2] : dims[1];
        const numClasses = Math.max(1, numAttrs - 4);

        const at = (a, c) => (channelsFirst ? data[c * numAnchors + a] : data[a * numAttrs + c]);

        for (let a = 0; a < numAnchors; a++) {
          let bestCls = 0;
          let bestConf = 0;
          for (let c = 0; c < numClasses; c++) {
            const sc = at(a, 4 + c);
            if (sc > bestConf) {
              bestConf = sc;
              bestCls = c;
            }
          }
          if (bestConf < minConf) continue;

          const cx = at(a, 0);
          const cy = at(a, 1);
          const bw = at(a, 2);
          const bh = at(a, 3);

          const x1 = Math.max(0, Math.round(((cx - bw / 2 - padX) / scale) * sx));
          const y1 = Math.max(0, Math.round(((cy - bh / 2 - padY) / scale) * sy));
          const x2 = Math.min(uiW, Math.round(((cx + bw / 2 - padX) / scale) * sx));
          const y2 = Math.min(uiH, Math.round(((cy + bh / 2 - padY) / scale) * sy));
          if (x2 - x1 < 8 || y2 - y1 < 8) continue;

          rawBoxes.push({
            cls: this.onnxLabels[bestCls] || `weapon_${bestCls}`,
            conf: bestConf,
            box: [x1, y1, x2, y2]
          });
        }
      }

      // NMS simple por IoU > 0.45
      rawBoxes.sort((a, b) => b.conf - a.conf);
      const kept = [];
      for (const cand of rawBoxes) {
        const overlap = kept.some((k) => {
          const xA = Math.max(k.box[0], cand.box[0]);
          const yA = Math.max(k.box[1], cand.box[1]);
          const xB = Math.min(k.box[2], cand.box[2]);
          const yB = Math.min(k.box[3], cand.box[3]);
          const inter = Math.max(0, xB - xA) * Math.max(0, yB - yA);
          const a1 = (k.box[2] - k.box[0]) * (k.box[3] - k.box[1]);
          const a2 = (cand.box[2] - cand.box[0]) * (cand.box[3] - cand.box[1]);
          return inter / Math.max(1, a1 + a2 - inter) > 0.45;
        });
        if (!overlap) {
          kept.push(cand);
          if (kept.length >= 15) break;
        }
      }

      const dets = [];
      for (const k of kept) {
        const item = this._classify(k.cls, k.conf, k.box, uiW, uiH, "onnx");
        if (item) dets.push(item);
      }
      return dets;
    }

    async infer(sourceVideo, mirror, options) {
      if (!this.ready || this.busy) return null;
      this.busy = true;
      const t0 = performance.now();
      const { minConf, poseEnabled, uiW, uiH } = options;

      try {
        // Dibujar frame sincronizado en canvas de trabajo 640x360
        const wctx = this.workCtx;
        wctx.save();
        if (mirror) {
          wctx.translate(WORK_W, 0);
          wctx.scale(-1, 1);
        }
        wctx.drawImage(sourceVideo, 0, 0, WORK_W, WORK_H);
        wctx.restore();

        const sx = uiW / WORK_W;
        const sy = uiH / WORK_H;
        const dets = [];

        // 1. COCO-SSD
        const preds = await this.objModel.detect(this.workCanvas, 20, minConf);
        for (const p of preds) {
          const [x, y, bw, bh] = p.bbox;
          const box = [
            Math.max(0, Math.round(x * sx)),
            Math.max(0, Math.round(y * sy)),
            Math.min(uiW, Math.round((x + bw) * sx)),
            Math.min(uiH, Math.round((y + bh) * sy))
          ];
          const item = this._classify(p.class, p.score, box, uiW, uiH, "coco");
          if (item) dets.push(item);
        }

        // 2. Especialista ONNX (si el usuario cargó uno)
        if (this.onnxSession) {
          const customDets = await this._runOnnxYolo(Math.max(0.25, minConf), uiW, uiH);
          for (const d of customDets) dets.push(d);
        }

        // 3. MoveNet MultiPose (17 keypoints compatibles con COCO)
        const poses = [];
        if (poseEnabled && this.poseDetector) {
          const rawPoses = await this.poseDetector.estimatePoses(this.workCanvas);
          for (const rp of rawPoses) {
            if (!rp.keypoints || rp.keypoints.length < 17) continue;
            const kpts = rp.keypoints.map((k) => [k.x * sx, k.y * sy, k.score || 0]);
            let x1 = uiW, y1 = uiH, x2 = 0, y2 = 0, valid = 0;
            for (const [kx, ky, ks] of kpts) {
              if (ks > 0.30) {
                x1 = Math.min(x1, kx);
                y1 = Math.min(y1, ky);
                x2 = Math.max(x2, kx);
                y2 = Math.max(y2, ky);
                valid++;
              }
            }
            if (valid >= 4) {
              poses.push({
                box: [
                  Math.max(0, Math.round(x1 - 16)),
                  Math.max(0, Math.round(y1 - 24)),
                  Math.min(uiW, Math.round(x2 + 16)),
                  Math.min(uiH, Math.round(y2 + 18))
                ],
                kpts
              });
            }
          }
        }

        this.lastLatencyMs = performance.now() - t0;
        return { dets, poses, latencyMs: this.lastLatencyMs };
      } catch (err) {
        console.warn("[AI INFER WARN]", err);
        return null;
      } finally {
        this.busy = false;
      }
    }
  }

  global.SentinelAIEngine = SentinelAIEngine;
})(window);
