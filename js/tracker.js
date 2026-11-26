/**
 * SENTINEL PRO WEB — Tracker Multi-Objeto + Analítica Biomecánica Anti-Falsos Positivos
 */
(function (global) {
  function iouBoxes(b1, b2) {
    const xA = Math.max(b1[0], b2[0]);
    const yA = Math.max(b1[1], b2[1]);
    const xB = Math.min(b1[2], b2[2]);
    const yB = Math.min(b1[3], b2[3]);
    const inter = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    if (inter <= 0) return 0;
    const a1 = Math.max(1, (b1[2] - b1[0]) * (b1[3] - b1[1]));
    const a2 = Math.max(1, (b2[2] - b2[0]) * (b2[3] - b2[1]));
    return inter / (a1 + a2 - inter);
  }

  function boxesOverlap(b1, b2, margin = 12) {
    return !(
      b1[2] + margin < b2[0] ||
      b1[0] - margin > b2[2] ||
      b1[3] + margin < b2[1] ||
      b1[1] - margin > b2[3]
    );
  }

  function boxCenter(b) {
    return [(b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5];
  }

  function boxFoot(b) {
    return [(b[0] + b[2]) * 0.5, b[3]];
  }

  function distPts(p1, p2) {
    return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
  }

  function pointNearBox(pt, box, margin = 42) {
    return (
      pt[0] >= box[0] - margin &&
      pt[0] <= box[2] + margin &&
      pt[1] >= box[1] - margin &&
      pt[1] <= box[3] + margin
    );
  }

  function pointInPolygon(pt, poly) {
    if (!poly || poly.length < 3) return false;
    let inside = false;
    const x = pt[0], y = pt[1];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-6) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * Analítica biomecánica de caída + manos arriba.
   * Bloquea falsas caídas si solo aparece la cabeza o torso parcial pegado a bordes.
   */
  function analyzePersonPose(kpts, box, frameW, frameH, poseEnabled) {
    const res = { manosArriba: false, caidoInst: false, munecas: [], vistaParcial: false };
    const pw = Math.max(1, box[2] - box[0]);
    const ph = Math.max(1, box[3] - box[1]);
    const tocaBordeInf = box[3] >= frameH - 18;
    const tocaBordeSup = box[1] <= 12;

    if (!kpts || kpts.length < 17) {
      res.vistaParcial = tocaBordeInf || tocaBordeSup || ph < 75;
      if (!poseEnabled && !res.vistaParcial) {
        const enZonaSuelo = box[3] > frameH * 0.55;
        res.caidoInst = enZonaSuelo && pw / ph > 1.72;
      }
      return res;
    }

    const nariz = kpts[0];
    const hIzq = kpts[5], hDer = kpts[6];
    const mIzq = kpts[9], mDer = kpts[10];
    const cIzq = kpts[11], cDer = kpts[12];

    for (const m of [mIzq, mDer]) {
      if (m[2] > 0.35) res.munecas.push([m[0], m[1]]);
    }

    // 1. Manos arriba (asalto)
    if (hIzq[2] > 0.35 && hDer[2] > 0.35 && mIzq[2] > 0.35 && mDer[2] > 0.35) {
      let refY = Math.min(hIzq[1], hDer[1]);
      if (nariz[2] > 0.35) refY = (refY + nariz[1]) * 0.5;
      if (mIzq[1] < refY && mDer[1] < refY) {
        res.manosArriba = true;
      }
    }

    // 2. Guardia estricta de cuerpo completo (evita marcar cabeza/busto como caído)
    const hombrosOk = hIzq[2] > 0.40 && hDer[2] > 0.40;
    const caderasOk =
      cIzq[2] > 0.45 &&
      cDer[2] > 0.45 &&
      cIzq[1] < frameH - 16 &&
      cDer[1] < frameH - 16;
    const piernasOk = [13, 14, 15, 16].some(
      (i) => kpts[i][2] > 0.40 && kpts[i][1] < frameH - 12
    );

    if (!(hombrosOk && caderasOk && piernasOk)) {
      res.vistaParcial = true;
      return res;
    }

    // 3. Ángulo horizontal de torso + proporción de caja
    const sx = (hIzq[0] + hDer[0]) * 0.5;
    const sy = (hIzq[1] + hDer[1]) * 0.5;
    const hx = (cIzq[0] + cDer[0]) * 0.5;
    const hy = (cIzq[1] + cDer[1]) * 0.5;
    const dx = Math.abs(hx - sx);
    const dy = Math.abs(hy - sy);

    if (Math.hypot(dx, dy) > 28) {
      const anguloHoriz = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (anguloHoriz < 30 && pw > ph * 1.15) {
        res.caidoInst = true;
      }
    }
    return res;
  }

  function detectFights(personas) {
    const fighting = new Set();
    for (let i = 0; i < personas.length; i++) {
      for (let j = i + 1; j < personas.length; j++) {
        const p1 = personas[i], p2 = personas[j];
        if (iouBoxes(p1.box, p2.box) > 0.18 && p1.vel + p2.vel > 350) {
          fighting.add(p1.tid);
          fighting.add(p2.tid);
        }
      }
    }
    return fighting;
  }

  class TacticalTracker {
    constructor() {
      this.tracks = new Map();
      this.nextId = 1;
      this.entradas = 0;
      this.salidas = 0;
      this.maxAgeSec = 1.4;
    }

    reset() {
      this.tracks.clear();
      this.entradas = 0;
      this.salidas = 0;
    }

    /** Suavizado fluido entre frames de UI sin alterar hits ni velocidad real */
    interpolateStep(dt) {
      const factor = Math.min(1, dt * 12);
      for (const tr of this.tracks.values()) {
        for (let i = 0; i < 4; i++) {
          tr.box[i] += (tr.targetBox[i] - tr.box[i]) * factor;
        }
      }
    }

    /** Asociación sincronizada únicamente cuando termina una inferencia IA */
    updateEpoch(dets, poses, nowSec, lineaY) {
      const updated = new Set();
      const usedDets = new Set();
      const pairs = [];

      for (const [tid, tr] of this.tracks.entries()) {
        dets.forEach((det, dIdx) => {
          if (tr.grupo !== det.grupo) return;
          const iou = iouBoxes(tr.targetBox, det.box);
          const dist = distPts(boxCenter(tr.targetBox), boxCenter(det.box));
          if (iou >= 0.14 || dist <= 130) {
            pairs.push({ score: iou * 2.5 - dist / 220, tid, dIdx });
          }
        });
      }

      pairs.sort((a, b) => b.score - a.score);

      for (const p of pairs) {
        if (updated.has(p.tid) || usedDets.has(p.dIdx)) continue;
        updated.add(p.tid);
        usedDets.add(p.dIdx);

        const tr = this.tracks.get(p.tid);
        const det = dets[p.dIdx];
        const dt = Math.max(0.03, nowSec - tr.lastSeen);
        const cNuevo = boxCenter(det.box);
        const velInst = distPts(cNuevo, tr.prevCenter) / dt;

        if (lineaY !== null && ["persona", "vehiculo", "moto"].includes(tr.grupo)) {
          const ladoAct = cNuevo[1] >= lineaY ? 1 : -1;
          if (tr.ladoLinea !== 0 && ladoAct !== tr.ladoLinea && nowSec - tr.ultimoCruce > 1.5) {
            if (tr.ladoLinea === -1 && ladoAct === 1) this.entradas++;
            else this.salidas++;
            tr.ultimoCruce = nowSec;
          }
          tr.ladoLinea = ladoAct;
        }

        tr.targetBox = [...det.box];
        tr.vel = 0.65 * tr.vel + 0.35 * velInst;
        tr.prevCenter = cNuevo;
        tr.conf = 0.6 * tr.conf + 0.4 * det.conf;
        tr.label = det.label;
        tr.lastSeen = nowSec;
        tr.hits += 1;
        tr.missed = 0;
        tr.historial.push(cNuevo);
        if (tr.historial.length > 26) tr.historial.shift();
      }

      // Nuevos tracks
      dets.forEach((det, dIdx) => {
        if (usedDets.has(dIdx)) return;
        const c = boxCenter(det.box);
        const lado = lineaY !== null ? (c[1] >= lineaY ? 1 : -1) : 0;
        this.tracks.set(this.nextId, {
          tid: this.nextId,
          grupo: det.grupo,
          label: det.label,
          conf: det.conf,
          box: [...det.box],
          targetBox: [...det.box],
          prevCenter: c,
          firstSeen: nowSec,
          lastSeen: nowSec,
          hits: 1,
          missed: 0,
          vel: 0,
          tiempoZona: 0,
          tiempoSinDueno: 0,
          tiempoManosArriba: 0,
          tiempoCaido: 0,
          ultimoCruce: 0,
          ladoLinea: lado,
          riesgo: 0,
          poseKpts: null,
          historial: [c]
        });
        this.nextId++;
      });

      // Purgar vencidos
      for (const [tid, tr] of this.tracks.entries()) {
        if (!updated.has(tid)) tr.missed += 1;
        if (nowSec - tr.lastSeen > this.maxAgeSec) {
          this.tracks.delete(tid);
        }
      }

      // Vincular keypoints de MoveNet a tracks de personas
      for (const tr of this.tracks.values()) {
        if (tr.grupo !== "persona") continue;
        let bestIou = 0.25;
        let bestKpts = null;
        for (const p of poses) {
          const v = iouBoxes(tr.targetBox, p.box);
          if (v > bestIou) {
            bestIou = v;
            bestKpts = p.kpts;
          }
        }
        if (bestKpts) tr.poseKpts = bestKpts;
        else if (tr.missed > 2) tr.poseKpts = null;
      }
    }

    getActive() {
      const out = [];
      for (const tr of this.tracks.values()) {
        if (tr.hits >= 2 || ["arma_fuego", "arma_blanca", "arma_contundente"].includes(tr.grupo)) {
          out.push(tr);
        }
      }
      return out;
    }
  }

  global.SentinelTracker = {
    TacticalTracker,
    iouBoxes,
    boxesOverlap,
    boxCenter,
    boxFoot,
    distPts,
    pointNearBox,
    pointInPolygon,
    analyzePersonPose,
    detectFights
  };
})(window);
