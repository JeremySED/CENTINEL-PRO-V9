/**
 * SENTINEL PRO WEB — Aplicación Principal VMS (Cámara Interna/USB + Video CCTV + HUD + Overlays)
 */
(function () {
  const UI_W = 1280;
  const UI_H = 720;

  const {
    TacticalTracker,
    boxesOverlap,
    boxCenter,
    boxFoot,
    distPts,
    pointNearBox,
    pointInPolygon,
    analyzePersonPose,
    detectFights
  } = window.SentinelTracker;

  const POSE_LINKS = [
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
    [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]
  ];

  // Referencias DOM
  const $ = (id) => document.getElementById(id);
  const videoEl = $("videoSource");
  const mainCanvas = $("mainCanvas");
  const ctx = mainCanvas.getContext("2d");
  const pipCanvas = $("pipCanvas");
  const pipCtx = pipCanvas.getContext("2d");

  const btnStartCam = $("btnStartCam");
  const btnSwitchCam = $("btnSwitchCam");
  const inputVideo = $("inputVideo");
  const inputOnnx = $("inputOnnx");
  const btnDvr = $("btnDvr");
  const btnSnap = $("btnSnap");
  const btnExportCsv = $("btnExportCsv");
  const btnResetMetrics = $("btnResetMetrics");

  const chkIa = $("chkIa");
  const chkPose = $("chkPose");
  const chkEspejo = $("chkEspejo");
  const chkZona = $("chkZona");
  const chkLinea = $("chkLinea");
  const chkHeat = $("chkHeat");
  const chkRadar = $("chkRadar");
  const chkSirena = $("chkSirena");
  const selOptico = $("selOptico");
  const sldConf = $("sldConf");
  const sldHits = $("sldHits");

  // Offscreen para Heatmap (1/4 resolución) y Térmico FLIR
  const hmCanvas = document.createElement("canvas");
  hmCanvas.width = UI_W / 4;
  hmCanvas.height = UI_H / 4;
  const hmCtx = hmCanvas.getContext("2d");

  const flirCanvas = document.createElement("canvas");
  flirCanvas.width = 320;
  flirCanvas.height = 180;
  const flirCtx = flirCanvas.getContext("2d", { willReadFrequently: true });

  // LUT Inferno rápida para modo térmico FLIR
  const FLIR_LUT = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    FLIR_LUT[i * 3] = Math.min(255, Math.round(255 * Math.pow(t, 0.55)));
    FLIR_LUT[i * 3 + 1] = Math.min(255, Math.round(255 * Math.pow(Math.max(0, t - 0.28) / 0.72, 1.35)));
    FLIR_LUT[i * 3 + 2] = Math.min(255, Math.round(255 * Math.sin(t * Math.PI) * 0.65));
  }

  // Estado del sistema
  const ai = new window.SentinelAIEngine();
  const tracker = new TacticalTracker();
  const forensics = new window.SentinelForensics({
    onNewEvent: appendEventRow,
    onDvrState: (rec) => {
      btnDvr.classList.toggle("recording", rec);
      btnDvr.textContent = rec ? "■ DETENER DVR" : "● GRABAR DVR";
    },
    onClipReady: (name, url, count) => {
      $("cntClips").textContent = String(count);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.className = "clip-link";
      a.textContent = `⬇ ${name}`;
      $("clipsList").prepend(a);
    }
  });

  let currentStream = null;
  let videoDevices = [];
  let currentCamIndex = 0;
  let sourceMode = "idle"; // 'webcam' | 'file' | 'idle'
  let videoObjectUrl = null;

  const ZONA_DEFECTO = [[400, 170], [880, 170], [960, 610], [320, 610]];
  let zonaPts = ZONA_DEFECTO.map((p) => [...p]);
  let clicksZona = [];

  let lastTs = performance.now();
  let fpsHist = [];
  let radarAngle = 0;
  let lastFocoBox = null;
  let lastRisk = 0;

  // ---- GESTIÓN DE CÁMARAS (INTERNA + EXTERNA USB) Y VIDEO CCTV ----
  function stopActiveSource() {
    if (currentStream) {
      currentStream.getTracks().forEach((t) => t.stop());
      currentStream = null;
    }
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
      videoObjectUrl = null;
    }
    videoEl.srcObject = null;
    videoEl.removeAttribute("src");
  }

  async function refreshCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devs.filter((d) => d.kind === "videoinput");
    btnSwitchCam.disabled = videoDevices.length < 1;
    btnSwitchCam.textContent =
      videoDevices.length > 1
        ? `Cambiar Cámara (${currentCamIndex + 1}/${videoDevices.length})`
        : "Cambiar Cámara";
    return videoDevices;
  }

  async function startWebcam(deviceId = null) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Tu navegador bloquea la cámara. Abre esta página desde HTTPS (GitHub Pages) o localhost.");
      return;
    }

    stopActiveSource();
    tracker.reset();

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } }
    };

    try {
      currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Fallback sin forzar resolución 720p en webcams USB antiguas
      currentStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId } } : true
      });
    }

    videoEl.srcObject = currentStream;
    videoEl.loop = false;
    await videoEl.play();
    sourceMode = "webcam";

    const activeTrack = currentStream.getVideoTracks()[0];
    const activeId = activeTrack.getSettings().deviceId;
    await refreshCameras();

    const foundIdx = videoDevices.findIndex((d) => d.deviceId === activeId);
    if (foundIdx >= 0) currentCamIndex = foundIdx;

    // Auto-espejo en cámara interna (índice 0); desactivado en cámara USB externa
    chkEspejo.checked = currentCamIndex === 0;
    btnSwitchCam.textContent =
      videoDevices.length > 1
        ? `Cambiar Cámara (${currentCamIndex + 1}/${videoDevices.length})`
        : "Cambiar Cámara";

    const camName = activeTrack.label || `Cámara ${currentCamIndex + 1}`;
    $("lblCameraInfo").textContent = `Fuente: ${camName} (${videoEl.videoWidth}x${videoEl.videoHeight})`;
    $("overlayHint").classList.add("hidden");
    $("dotLive").classList.add("active");
    forensics.log("INFO", "CAMARA ACTIVA", camName.slice(0, 24), null, null, 0, 1);
  }

  async function switchCamera() {
    await refreshCameras();
    if (videoDevices.length <= 1) {
      await startWebcam(videoDevices[0] ? videoDevices[0].deviceId : null);
      return;
    }
    currentCamIndex = (currentCamIndex + 1) % videoDevices.length;
    await startWebcam(videoDevices[currentCamIndex].deviceId);
  }

  async function loadVideoFile(file) {
    stopActiveSource();
    tracker.reset();
    videoObjectUrl = URL.createObjectURL(file);
    videoEl.src = videoObjectUrl;
    videoEl.loop = true;
    await videoEl.play();
    sourceMode = "file";
    chkEspejo.checked = false;
    $("lblCameraInfo").textContent = `Video: ${file.name}`;
    $("overlayHint").classList.add("hidden");
    $("dotLive").classList.add("active");
    forensics.log("INFO", "VIDEO CARGADO", file.name.slice(0, 24), null, null, 0, 1);
  }

  // ---- DIBUJO TÁCTICO ----
  function drawBaseVideo() {
    const mode = Number(selOptico.value);
    const mirror = sourceMode === "webcam" && chkEspejo.checked;

    if (mode === 2) {
      // Térmico FLIR vía LUT
      flirCtx.save();
      if (mirror) {
        flirCtx.translate(flirCanvas.width, 0);
        flirCtx.scale(-1, 1);
      }
      flirCtx.drawImage(videoEl, 0, 0, flirCanvas.width, flirCanvas.height);
      flirCtx.restore();

      const frameData = flirCtx.getImageData(0, 0, flirCanvas.width, flirCanvas.height);
      const px = frameData.data;
      for (let i = 0; i < px.length; i += 4) {
        const g = Math.min(255, Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]));
        px[i] = FLIR_LUT[g * 3];
        px[i + 1] = FLIR_LUT[g * 3 + 1];
        px[i + 2] = FLIR_LUT[g * 3 + 2];
      }
      flirCtx.putImageData(frameData, 0, 0);
      ctx.drawImage(flirCanvas, 0, 0, UI_W, UI_H);
      return;
    }

    ctx.save();
    if (mode === 0) ctx.filter = "contrast(1.16) saturate(1.24) brightness(1.03)";
    else if (mode === 1) ctx.filter = "grayscale(1) contrast(1.35) brightness(1.12)";
    else ctx.filter = "none";

    if (mirror) {
      ctx.translate(UI_W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, 0, 0, UI_W, UI_H);
    ctx.restore();

    if (mode === 1) {
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgb(45, 255, 95)";
      ctx.fillRect(0, 0, UI_W, UI_H);
      ctx.restore();
    }
  }

  function drawTacticalBox(box, color, title, subtitle = "", history = null) {
    const [x1, y1, x2, y2] = box.map((v) => Math.round(v));
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const corner = Math.max(10, Math.round(Math.min(w, h) * 0.2));

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x1, y1, w, h);

    // Esquinas reforzadas
    ctx.lineWidth = 3;
    const corners = [
      [x1, y1, 1, 1], [x2, y1, -1, 1],
      [x1, y2, 1, -1], [x2, y2, -1, -1]
    ];
    for (const [px, py, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(px + dx * corner, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * corner);
      ctx.stroke();
    }

    // Trayectoria
    if (history && history.length > 1) {
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.moveTo(history[0][0], history[0][1]);
      for (let i = 1; i < history.length; i++) ctx.lineTo(history[i][0], history[i][1]);
      ctx.stroke();
    }

    // Etiqueta superior
    ctx.font = "bold 13px 'Segoe UI', Arial, sans-serif";
    const tw = ctx.measureText(title).width;
    const ty = Math.max(24, y1 - 6);
    ctx.fillStyle = "rgba(10, 12, 18, 0.85)";
    ctx.fillRect(x1, ty - 18, tw + 12, 22);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x1, ty - 18, tw + 12, 22);
    ctx.fillStyle = color;
    ctx.fillText(title, x1 + 6, ty - 3);

    if (subtitle) {
      ctx.font = "12px 'Segoe UI', Arial, sans-serif";
      const sw = ctx.measureText(subtitle).width;
      ctx.fillStyle = "rgba(10, 12, 18, 0.78)";
      ctx.fillRect(x1, y2 + 2, sw + 10, 18);
      ctx.fillStyle = "#e6edf3";
      ctx.fillText(subtitle, x1 + 5, y2 + 15);
    }
  }

  function drawPoseSkeleton(kpts, color) {
    if (!kpts) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const [i, j] of POSE_LINKS) {
      if (kpts[i][2] > 0.35 && kpts[j][2] > 0.35) {
        ctx.beginPath();
        ctx.moveTo(kpts[i][0], kpts[i][1]);
        ctx.lineTo(kpts[j][0], kpts[j][1]);
        ctx.stroke();
      }
    }
    ctx.fillStyle = "#ffffff";
    for (const idx of [0, 5, 6, 7, 8, 9, 10, 11, 12]) {
      if (kpts[idx][2] > 0.35) {
        ctx.beginPath();
        ctx.arc(kpts[idx][0], kpts[idx][1], 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawRadar(tracks) {
    const r = 64;
    const cx = UI_W - r - 18;
    const cy = UI_H - r - 18;

    ctx.fillStyle = "rgba(10, 16, 22, 0.82)";
    ctx.fillRect(cx - r - 8, cy - r - 22, r * 2 + 16, r * 2 + 30);
    ctx.fillStyle = "#00ffb4";
    ctx.font = "bold 11px monospace";
    ctx.fillText("RADAR 2D", cx - 28, cy - r - 8);

    ctx.strokeStyle = "rgba(0, 160, 115, 0.6)";
    ctx.lineWidth = 1;
    for (const rad of [r, r * 0.66, r * 0.33]) {
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    const rad = (radarAngle * Math.PI) / 180;
    ctx.strokeStyle = "#00ffa0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.stroke();

    for (const tr of tracks) {
      const c = boxCenter(tr.box);
      const tx = cx + (c[0] / UI_W - 0.5) * 2 * (r - 6);
      const ty = cy + (c[1] / UI_H - 0.5) * 2 * (r - 6);
      ctx.fillStyle = tr.riesgo >= 70 ? "#ff3b30" : tr.riesgo >= 35 ? "#ffb400" : "#00f0dc";
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function updatePip(box, title, risk) {
    if (!box) {
      $("lblPipTitle").textContent = "Sin objetivo";
      return;
    }
    const cx = (box[0] + box[2]) * 0.5;
    const cy = (box[1] + box[3]) * 0.5;
    const hw = Math.max(70, (box[2] - box[0]) * 0.72);
    const hh = Math.max(70, (box[3] - box[1]) * 0.72);
    const rx1 = Math.max(0, cx - hw);
    const ry1 = Math.max(0, cy - hh);
    const rw = Math.min(UI_W - rx1, hw * 2);
    const rh = Math.min(UI_H - ry1, hh * 2);
    if (rw < 20 || rh < 20) return;

    pipCtx.drawImage(mainCanvas, rx1, ry1, rw, rh, 0, 0, pipCanvas.width, pipCanvas.height);
    pipCtx.strokeStyle = risk >= 70 ? "#ff3b30" : "#00d2ff";
    pipCtx.lineWidth = 1;
    pipCtx.beginPath();
    pipCtx.moveTo(142, 80);
    pipCtx.lineTo(178, 80);
    pipCtx.moveTo(160, 62);
    pipCtx.lineTo(160, 98);
    pipCtx.stroke();

    $("lblPipTitle").textContent = `[${risk}%] ${title}`;
    $("lblPipTitle").style.color = risk >= 70 ? "#ff7b72" : "#58a6ff";
  }

  // ---- BUCLE PRINCIPAL (~60 FPS UI + IA ASÍNCRONA) ----
  function loop(nowMs) {
    requestAnimationFrame(loop);

    const dt = Math.max(0.001, Math.min(0.1, (nowMs - lastTs) / 1000));
    lastTs = nowMs;
    fpsHist.push(dt);
    if (fpsHist.length > 35) fpsHist.shift();
    const fpsUi = fpsHist.length / fpsHist.reduce((a, b) => a + b, 0);
    radarAngle = (radarAngle + 180 * dt) % 360;
    $("lblClock").textContent = new Date().toLocaleTimeString();

    if (sourceMode === "idle" || videoEl.readyState < 2) return;

    const nowSec = nowMs / 1000;
    const lineaY = Math.round(UI_H * 0.65);

    // 1. Disparar inferencia IA asíncrona sin bloquear renderizado
    if (chkIa.checked && ai.ready && !ai.busy) {
      const mirror = sourceMode === "webcam" && chkEspejo.checked;
      ai.infer(videoEl, mirror, {
        minConf: Number(sldConf.value) / 100,
        poseEnabled: chkPose.checked,
        uiW: UI_W,
        uiH: UI_H
      }).then((res) => {
        if (!res) return;
        tracker.updateEpoch(
          res.dets,
          res.poses,
          performance.now() / 1000,
          chkLinea.checked ? lineaY : null
        );
      });
    }

    tracker.interpolateStep(dt);
    const tracks = chkIa.checked ? tracker.getActive() : [];

    // 2. Renderizar video base
    drawBaseVideo();

    const personas = tracks.filter((t) => t.grupo === "persona");
    const armas = tracks.filter((t) => ["arma_fuego", "arma_blanca", "arma_contundente"].includes(t.grupo));
    const minHitsArma = Number(sldHits.value);
    const isWeaponConfirmed = (a) => a.hits >= minHitsArma || (a.hits >= 2 && a.conf >= 0.66);
    const armasOk = armas.filter(isWeaponConfirmed);
    const cascos = tracks.filter((t) => t.grupo === "casco");
    const vehiculos = tracks.filter((t) => t.grupo === "vehiculo");
    const motos = tracks.filter((t) => t.grupo === "moto");
    const bultos = tracks.filter((t) => t.grupo === "bulto");

    // 3. Heatmap
    hmCtx.fillStyle = "rgba(0,0,0,0.03)";
    hmCtx.fillRect(0, 0, hmCanvas.width, hmCanvas.height);
    for (const tr of [...personas, ...vehiculos, ...motos]) {
      const c = boxCenter(tr.box);
      const grad = hmCtx.createRadialGradient(c[0] / 4, c[1] / 4, 1, c[0] / 4, c[1] / 4, 12);
      grad.addColorStop(0, "rgba(255, 60, 0, 0.35)");
      grad.addColorStop(1, "rgba(255, 180, 0, 0)");
      hmCtx.fillStyle = grad;
      hmCtx.beginPath();
      hmCtx.arc(c[0] / 4, c[1] / 4, 12, 0, Math.PI * 2);
      hmCtx.fill();
    }
    if (chkHeat.checked) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.globalCompositeOperation = "screen";
      ctx.drawImage(hmCanvas, 0, 0, UI_W, UI_H);
      ctx.restore();
    }

    // 4. Zona restringida y Línea de conteo
    let intrusosZona = 0;
    if (chkZona.checked && zonaPts.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(zonaPts[0][0], zonaPts[0][1]);
      for (let i = 1; i < zonaPts.length; i++) ctx.lineTo(zonaPts[i][0], zonaPts[i][1]);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 120, 0, 0.08)";
      ctx.fill();
      ctx.strokeStyle = "#ff8c00";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#ffa500";
      ctx.font = "bold 12px 'Segoe UI', Arial";
      ctx.fillText("ZONA RESTRINGIDA", zonaPts[0][0] + 6, Math.max(20, zonaPts[0][1] - 8));
    }

    if (chkLinea.checked) {
      ctx.strokeStyle = "#ffd900";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(40, lineaY);
      ctx.lineTo(UI_W - 40, lineaY);
      ctx.stroke();
      ctx.fillStyle = "#ffd900";
      ctx.font = "bold 13px 'Segoe UI', Arial";
      ctx.fillText(`CONTEO | IN: ${tracker.entradas} | OUT: ${tracker.salidas}`, 50, lineaY - 8);
    }

    // 5. Evaluación de riesgos
    let riesgoGlobal = 0;
    let alertaCritica = false;
    let focoBox = null;
    let focoTit = "";
    let focoRiesgo = -1;

    const updateFocus = (box, tit, r) => {
      riesgoGlobal = Math.max(riesgoGlobal, r);
      if (r > focoRiesgo) {
        focoBox = box;
        focoTit = tit;
        focoRiesgo = r;
      }
    };

    // Bultos abandonados
    for (const b of bultos) {
      const c = boxCenter(b.box);
      const near = personas.some((p) => distPts(c, boxCenter(p.box)) < 175);
      if (near || b.vel >= 25) b.tiempoSinDueno = Math.max(0, b.tiempoSinDueno - dt * 2);
      else b.tiempoSinDueno += dt;

      if (b.tiempoSinDueno >= 7.0) {
        b.riesgo = 85;
        alertaCritica = true;
        updateFocus(b.box, "BULTO ABANDONADO", 85);
        drawTacticalBox(b.box, "#ff3b30", `ID#${b.tid} ABANDONADO (${b.tiempoSinDueno.toFixed(0)}s)`, "SOSPECHOSO");
        forensics.log("CRITICO", "OBJETO ABANDONADO", `ID#${b.tid}`, mainCanvas, b.box, 85);
      } else {
        b.riesgo = 10;
        drawTacticalBox(b.box, "#c8b400", `ID#${b.tid} ${b.label}`);
      }
    }

    // Motos (2 ocupantes / motochorro) y vehículos
    for (const m of motos) {
      const ocupantes = personas.filter((p) => boxesOverlap(p.box, m.box, 20));
      if (ocupantes.length >= 2) {
        m.riesgo = 60;
        updateFocus(m.box, "MOTO 2 OCUPANTES", 60);
        drawTacticalBox(m.box, "#ff6400", `ID#${m.tid} ALERTA: 2 EN MOTO`, `Vel:${m.vel.toFixed(0)}px/s`, m.historial);
        forensics.log("ALERTA", "MOTO 2 OCUPANTES", `ID#${m.tid}`, mainCanvas, m.box, 60, 8);
      } else {
        m.riesgo = 15;
        drawTacticalBox(m.box, "#ff8c00", `ID#${m.tid} ${m.label} (${Math.round(m.conf * 100)}%)`, `Vel:${m.vel.toFixed(0)}px/s`, m.historial);
      }
    }

    for (const v of vehiculos) {
      v.riesgo = 10;
      drawTacticalBox(v.box, "#ffc300", `ID#${v.tid} ${v.label} (${Math.round(v.conf * 100)}%)`, `Vel:${v.vel.toFixed(0)}px/s`, v.historial);
    }
    for (const c of cascos) {
      drawTacticalBox(c.box, "#00ff78", `CASCO (${Math.round(c.conf * 100)}%)`);
    }

    // Personas + Pose biomecánica corregida
    const fightingIds = detectFights(personas);
    for (const p of personas) {
      const bio = analyzePersonPose(p.poseKpts, p.box, UI_W, UI_H, chkPose.checked);

      if (bio.manosArriba) p.tiempoManosArriba += dt;
      else p.tiempoManosArriba = Math.max(0, p.tiempoManosArriba - dt * 2);

      if (bio.caidoInst && p.vel < 120) p.tiempoCaido += dt;
      else p.tiempoCaido = Math.max(0, p.tiempoCaido - dt * 2.5);

      const asaltoManos = p.tiempoManosArriba >= 1.1;
      const caido = p.tiempoCaido >= 1.5;
      const armado = armasOk.some(
        (a) =>
          (bio.munecas.length && bio.munecas.some((m) => pointNearBox(m, a.box, 44))) ||
          boxesOverlap(p.box, a.box, 8)
      );
      const enPelea = fightingIds.has(p.tid);
      const corriendo = p.vel > 310;
      const tEscena = nowSec - p.firstSeen;

      let enZona = false;
      if (chkZona.checked && zonaPts.length >= 3) {
        enZona = pointInPolygon(boxFoot(p.box), zonaPts);
        if (enZona) {
          intrusosZona++;
          p.tiempoZona += dt;
        }
      }
      const merodeo = p.tiempoZona >= 10.0;
      const sufParcial = bio.vistaParcial ? " | PARCIAL" : "";

      let col = "#00e6ff";
      let tit = `ID#${p.tid} PERSONA (${Math.round(p.conf * 100)}%)`;
      let sub = `T:${tEscena.toFixed(0)}s${sufParcial}`;
      let riesgo = 15;

      if (armado) {
        riesgo = 100; alertaCritica = true;
        col = "#ff3b30"; tit = `ID#${p.tid} SUJETO ARMADO`; sub = "AMENAZA LETAL";
        forensics.log("CRITICO", "SUJETO ARMADO", `ID#${p.tid}`, mainCanvas, p.box, 100);
      } else if (asaltoManos) {
        riesgo = 92; alertaCritica = true;
        col = "#ff3b30"; tit = `ID#${p.tid} POSIBLE ASALTO`; sub = "MANOS ARRIBA";
        forensics.log("CRITICO", "POSIBLE ASALTO (MANOS ARRIBA)", `ID#${p.tid}`, mainCanvas, p.box, 92);
      } else if (enPelea) {
        riesgo = 78; alertaCritica = true;
        col = "#ff453a"; tit = `ID#${p.tid} FORCEJEO / PELEA`; sub = `Vel:${p.vel.toFixed(0)}`;
        forensics.log("CRITICO", "FORCEJEO / PELEA", `ID#${p.tid}`, mainCanvas, p.box, 78, 6);
      } else if (caido) {
        riesgo = 75; alertaCritica = true;
        col = "#ff5e3a"; tit = `ID#${p.tid} PERSONA CAIDA (${p.tiempoCaido.toFixed(1)}s)`; sub = "EMERGENCIA";
        forensics.log("ALERTA", "PERSONA CAIDA", `ID#${p.tid}`, mainCanvas, p.box, 75);
      } else if (merodeo) {
        riesgo = 65;
        col = "#ff7800"; tit = `ID#${p.tid} MERODEO (${p.tiempoZona.toFixed(0)}s)`; sub = "SOSPECHOSO";
        forensics.log("ALERTA", "MERODEO", `ID#${p.tid}`, mainCanvas, p.box, 65, 10);
      } else if (enZona) {
        riesgo = 50;
        col = "#ff9f0a"; tit = `ID#${p.tid} INTRUSO (${p.tiempoZona.toFixed(1)}s)`; sub = "PERIMETRO";
        forensics.log("ALERTA", "INTRUSION ZONA", `ID#${p.tid}`, mainCanvas, p.box, 50, 8);
      } else if (corriendo) {
        riesgo = 35;
        col = "#ffd60a"; tit = `ID#${p.tid} HUIDA / CARRERA`; sub = `Vel:${p.vel.toFixed(0)}px/s`;
      }

      p.riesgo = riesgo;
      updateFocus(p.box, tit.split(" ").slice(1).join(" "), riesgo);
      if (chkPose.checked && p.poseKpts) drawPoseSkeleton(p.poseKpts, col);
      drawTacticalBox(p.box, col, tit, sub, p.historial);
    }

    // Armas con confirmación temporal
    for (const a of armas) {
      if (isWeaponConfirmed(a)) {
        a.riesgo = 100;
        alertaCritica = true;
        updateFocus(a.box, a.label, 100);
        drawTacticalBox(a.box, "#ff3b30", `! ${a.label} (${Math.round(a.conf * 100)}%) !`, "CONFIRMADO", a.historial);
        forensics.log("CRITICO", a.label, `${Math.round(a.conf * 100)}%`, mainCanvas, a.box, 100);
      } else {
        a.riesgo = 45;
        drawTacticalBox(a.box, "#ffd60a", `VERIFICANDO: ${a.label} (${a.hits}/${minHitsArma})`);
      }
    }

    // Banner crítico
    if (alertaCritica && Math.floor(nowSec * 8) % 2 === 0) {
      ctx.strokeStyle = "#ff2d20";
      ctx.lineWidth = 8;
      ctx.strokeRect(4, 4, UI_W - 8, UI_H - 8);
      ctx.fillStyle = "rgba(185, 0, 0, 0.88)";
      ctx.fillRect(UI_W / 2 - 220, 14, 440, 40);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 20px 'Segoe UI', Arial";
      ctx.fillText("! ALERTA CRITICA DE SEGURIDAD !", UI_W / 2 - 175, 41);
    }

    if (chkRadar.checked) drawRadar(tracks);

    lastFocoBox = focoBox;
    lastRisk = riesgoGlobal;
    forensics.tickDvr(mainCanvas, alertaCritica);
    updatePip(focoBox, focoTit, focoRiesgo);

    // Actualizar métricas UI
    $("lblPerf").textContent = `${Math.round(fpsUi)} FPS | ${Math.round(ai.lastLatencyMs)} ms`;
    $("cntPersonas").textContent = String(personas.length);
    $("cntAutos").textContent = String(vehiculos.length);
    $("cntMotos").textContent = String(motos.length);
    $("cntArmas").textContent = String(armasOk.length);
    $("cntZona").textContent = String(intrusosZona);
    $("cntFlujo").textContent = `+${tracker.entradas} / -${tracker.salidas}`;

    $("barRisk").style.width = `${riesgoGlobal}%`;
    $("lblRiskPct").textContent = `${riesgoGlobal}%`;
    const defcon = $("lblDefcon");
    if (riesgoGlobal >= 75) {
      defcon.textContent = "CRÍTICO";
      defcon.className = "defcon critico";
      $("barRisk").style.background = "#f85149";
    } else if (riesgoGlobal >= 40) {
      defcon.textContent = "ALERTA";
      defcon.className = "defcon alerta";
      $("barRisk").style.background = "#d29922";
    } else {
      defcon.textContent = "NORMAL";
      defcon.className = "defcon normal";
      $("barRisk").style.background = "#2ea043";
    }
  }

  // ---- TABLA FORENSE Y MODAL ----
  function appendEventRow(rec) {
    const tbody = $("tbodyLog");
    const tr = document.createElement("tr");
    tr.className = `lvl-${rec.nivel}`;
    tr.innerHTML = `<td>${rec.hora}</td><td>${rec.nivel}</td><td>${rec.evento} ${rec.detalles}</td><td>${rec.riesgo}</td>`;
    tr.addEventListener("click", () => {
      if (!rec.fullUrl) return;
      $("modalTitle").textContent = `${rec.fecha} — ${rec.evento} (${rec.riesgo}%)`;
      $("modalImgFull").src = rec.fullUrl;
      $("btnDownloadEv").href = rec.fullUrl;
      $("btnDownloadEv").download = `ev_${rec.evento.replace(/\W+/g, "_")}.jpg`;
      if (rec.cropUrl) {
        $("modalImgCrop").src = rec.cropUrl;
        $("modalImgCrop").classList.remove("hidden");
      } else {
        $("modalImgCrop").classList.add("hidden");
      }
      $("modalEvidencia").classList.remove("hidden");
    });
    tbody.prepend(tr);
    while (tbody.children.length > 120) tbody.removeChild(tbody.lastChild);
  }

  // ---- EVENTOS DE INTERFAZ Y MOUSE ----
  btnStartCam.addEventListener("click", () => startWebcam(null).catch((e) => alert("No se pudo abrir cámara: " + e.message)));
  btnSwitchCam.addEventListener("click", () => switchCamera().catch((e) => alert("Error cambiando cámara: " + e.message)));

  inputVideo.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadVideoFile(file);
  });

  inputOnnx.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      await ai.loadOnnxWeaponModel(buf, file.name, (msg) => ($("lblAiStatus").textContent = msg));
    } catch (err) {
      alert("No se pudo cargar el modelo ONNX: " + err.message);
    }
  });

  btnDvr.addEventListener("click", () => {
    if (forensics.recording) forensics.stopDvr();
    else forensics.startDvr(mainCanvas, true);
  });

  btnSnap.addEventListener("click", () => {
    if (sourceMode === "idle") return;
    forensics.log("ALERTA", "CAPTURA MANUAL", "Operador", mainCanvas, lastFocoBox, lastRisk, 0.2);
  });

  btnExportCsv.addEventListener("click", () => forensics.exportCsv());

  btnResetMetrics.addEventListener("click", () => {
    hmCtx.clearRect(0, 0, hmCanvas.width, hmCanvas.height);
    tracker.entradas = 0;
    tracker.salidas = 0;
  });

  chkSirena.addEventListener("change", () => (forensics.soundEnabled = chkSirena.checked));
  sldConf.addEventListener("input", () => ($("valConf").textContent = `${sldConf.value}%`));
  sldHits.addEventListener("input", () => ($("valHits").textContent = `${sldHits.value} frames`));

  $("btnCloseModal").addEventListener("click", () => $("modalEvidencia").classList.add("hidden"));
  $("modalEvidencia").addEventListener("click", (e) => {
    if (e.target === $("modalEvidencia")) $("modalEvidencia").classList.add("hidden");
  });

  // Dibujar zona restringida con mouse sobre el canvas
  mainCanvas.addEventListener("click", (e) => {
    const rect = mainCanvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * UI_W);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * UI_H);
    clicksZona.push([x, y]);
    if (clicksZona.length >= 3) zonaPts = clicksZona.map((p) => [...p]);
  });

  mainCanvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    clicksZona = [];
    zonaPts = ZONA_DEFECTO.map((p) => [...p]);
  });

  // Inicialización automática de motores IA al abrir la página
  ai.init((msg) => {
    $("lblAiStatus").textContent = msg;
  });
  requestAnimationFrame(loop);
})();
