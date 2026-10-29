// ─── State ───
let totalPulses = 0;
let history = [];
let noteMarkers = []; // parallèle à history : true aux positions où une note a été jouée
let noteRipples = []; // { idx, born } — cercles qui s'expandent autour des notes jouées
let lastPeakIdx = -1;
const MAX_HISTORY = 800;
const RIPPLE_MS = 800;
const ZONE_HOLD_MS = 450;
const ZONE_LOOKBACK = 12;
const MIN_VISIBLE_POINTS = 50;
const MAX_VISIBLE_POINTS = MAX_HISTORY;
const DEFAULT_VISIBLE_POINTS = 400;
const SPAN_FACTOR = 1.3;
let visibleCount = DEFAULT_VISIBLE_POINTS;

let lastBatchAvg = 0;

function isViewReady() {
  return Number.isFinite(globalMin) && Number.isFinite(globalMax) && globalMax > globalMin;
}

function viewRange() {
  const r = globalMax - globalMin;
  return Number.isFinite(r) && r > 0 ? r : 1;
}

function flushStatsDOM() {
  $("avg").textContent = lastBatchAvg.toLocaleString();
  $("min").textContent = isViewReady() ? globalMin.toLocaleString() : "—";
  $("max").textContent = isViewReady() ? globalMax.toLocaleString() : "—";
  $("total").textContent = totalPulses.toLocaleString();
}

// Stats + canvas : au plus une fois par frame (les messages WS peuvent être plus rapides que 60 Hz)
let graphRafId = null;
let needStatsFlush = false;
let needGraphDraw = false;

function pruneNoteRipples(now) {
  const t = now ?? performance.now();
  let w = 0;
  for (let i = 0; i < noteRipples.length; i++) {
    const r = noteRipples[i];
    if (r.idx >= 0 && t - r.born < RIPPLE_MS) noteRipples[w++] = r;
  }
  noteRipples.length = w;
}

function bumpVisualFrame() {
  if (graphRafId != null) return;
  graphRafId = requestAnimationFrame(() => {
    graphRafId = null;
    try {
      const adapted = tickViewAdaptation();
      if (adapted) needGraphDraw = true;
      if (needStatsFlush) {
        needStatsFlush = false;
        flushStatsDOM();
      }
      const liveRipples = graphAnimations && noteRipples.length > 0;
      const draw = needGraphDraw || liveRipples;
      if (draw) {
        needGraphDraw = false;
        drawGraph();
      }
      pruneNoteRipples();
      maybeSyncLinkedUi();
      if ((graphAnimations && noteRipples.length > 0) || adapted) bumpVisualFrame();
    } catch (err) {
      dbgError("RAF", err);
    }
  });
}

function requestVisualUpdate() {
  needStatsFlush = true;
  needGraphDraw = true;
  bumpVisualFrame();
}

function requestGraphRedraw() {
  needGraphDraw = true;
  bumpVisualFrame();
}

let lastSecondCount = 0;
let lastSecondTime = performance.now();
let globalMin = Infinity;
let globalMax = -Infinity;

// Draggable threshold lines (µs values)
let threshHi = 20500;
let threshLo = 19500;
let thresholdsEnabled = true;
const G_SPEC = {
  threshMarginPct: { min: 4, max: 100, def: 18 },
  threshSmoothMs: { min: 300, max: 20000, def: 2500 },
  zoomMarginPct: { min: 2, max: 120, def: 8 },
  zoomSmoothMs: { min: 200, max: 20000, def: 600 },
  zoneXfadeMs: { min: 80, max: 20000, def: 1200 },
};
const G = {
  dynamicThresholds: false,
  threshMarginPct: G_SPEC.threshMarginPct.def,
  threshSmoothMs: G_SPEC.threshSmoothMs.def,
  zoomMarginPct: G_SPEC.zoomMarginPct.def,
  zoomSmoothMs: G_SPEC.zoomSmoothMs.def,
  zoneXfadeMs: G_SPEC.zoneXfadeMs.def,
  zoneXfade: true,
  autoCenter: false,
  autoZoom: false,
};
let dynCenter = 20000;
let lastAdaptTick = 0;
let zoomHalf = NaN;
// L'ampleur du zoom est suivie à part : un pic ne recadre pas le graphe d'un coup.
const ZOOM_FOLLOW_S = 0.6;
// Historique plus long que le graphe : le lissage doit couvrir jusqu'à 20 s
// même si l'écran n'en montre qu'une partie, ou si le débit dépasse 50 Hz.
const MEAN_KEEP_US = 21000 * 1000;
const MEAN_MAX_SAMPLES = 12000;
let meanHist = [];
let meanStart = 0;
let meanCoveredUs = 0;

function displayRange() {
  if (isViewReady()) return { min: globalMin, max: globalMax, span: viewRange() };
  const lo = Math.min(threshLo, 19000);
  const hi = Math.max(threshHi, 21000);
  return { min: lo, max: hi, span: Math.max(hi - lo, 1) };
}

function viewPct(val) {
  const { min, span } = displayRange();
  if (!Number.isFinite(val)) return 50;
  return clamp(((val - min) / span) * 100, 0, 100);
}

function formatUs(v) {
  if (!Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString() + " µs";
}

function formatGeneralVal(key, raw) {
  if (key === "threshMarginPct" || key === "zoomMarginPct") return raw + " %";
  if (key === "threshSmoothMs" || key === "zoomSmoothMs" || key === "zoneXfadeMs") {
    if (raw < 1000) return Math.round(raw) + " ms";
    return (Math.round(raw / 100) / 10).toString().replace(".", ",") + " s";
  }
  return String(raw);
}

function tickViewAdaptation() {
  if (!G.autoCenter && !G.autoZoom && !G.dynamicThresholds) {
    lastAdaptTick = 0;
    return false;
  }
  if (history.length < 2) return false;
  const now = performance.now();
  const dt = lastAdaptTick ? Math.min(0.12, (now - lastAdaptTick) / 1000) : 0.016;
  lastAdaptTick = now;
  let changed = false;

  if ((G.autoCenter || G.autoZoom) && !pinch) {
    const targetCenter = (G.autoCenter || !isViewReady())
      ? autoCenterValue()
      : (globalMin + globalMax) / 2;
    const needSnap = !isViewReady() || (G.autoZoom && !Number.isFinite(zoomHalf));
    if (needSnap || !Number.isFinite(targetCenter)) {
      if (Number.isFinite(targetCenter)) {
        const half = frameHalf(targetCenter);
        if (G.autoZoom) zoomHalf = half;
        globalMin = Math.round(targetCenter - half);
        globalMax = Math.round(targetCenter + half);
        changed = true;
      }
    } else {
      let half = (globalMax - globalMin) / 2;
      if (G.autoZoom) {
        const targetHalf = autoZoomHalf(targetCenter);
        const coeff = 1 - Math.exp(-dt / ZOOM_FOLLOW_S);
        zoomHalf += (targetHalf - zoomHalf) * coeff;
        half = zoomHalf;
      }
      const nextMin = targetCenter - half;
      const nextMax = targetCenter + half;
      if (Math.abs(nextMin - globalMin) >= 0.5 || Math.abs(nextMax - globalMax) >= 0.5) {
        globalMin = Math.round(nextMin);
        globalMax = Math.round(nextMax);
        changed = true;
        needStatsFlush = true;
      }
    }
  }

  if (G.dynamicThresholds && isViewReady()) {
    const mean = recentMean(G.threshSmoothMs);
    if (Number.isFinite(mean)) dynCenter = mean;
    const range = viewRange();
    const margin = Math.max(range * (G.threshMarginPct / 100), 25);
    let nextLo = Math.round(dynCenter - margin);
    let nextHi = Math.round(dynCenter + margin);
    if (nextHi - nextLo < 50) {
      nextLo = Math.round(dynCenter - 25);
      nextHi = Math.round(dynCenter + 25);
    }
    if (nextLo !== threshLo || nextHi !== threshHi) {
      threshLo = nextLo;
      threshHi = nextHi;
      changed = true;
    }
  }

  return changed;
}
const GRAPH_ANIM_KEY = "plante-graph-anim";
let graphAnimations = true;
let graphAnimFromConfig = false;
let dragging = null; // "hi" | "lo" | null
let panning = false;
let pinch = null;
let panLastY = 0;
const DRAG_SNAP_PX = 12;
let currentZone = "vegetal"; // "vegetal" | "interaction"
let zoneHoldUntil = 0;
let smoothedZone = 0; // 0 = végétal seul, 1 = toucher par-dessus
let lastPulseAt = 0;
let signalGain = 0; // 1 = impulsions récentes, 0 = silence
let viewFitted = false;

function visibleMinMax() {
  const start = visibleStart();
  let lo = history[start];
  let hi = history[start];
  for (let i = start + 1; i < history.length; i++) {
    if (history[i] < lo) lo = history[i];
    if (history[i] > hi) hi = history[i];
  }
  return [lo, hi];
}

function pushMeanSamples(intervals) {
  for (let i = 0; i < intervals.length; i++) {
    const v = intervals[i];
    if (!Number.isFinite(v) || v <= 0) continue;
    meanHist.push(v);
    meanCoveredUs += v;
  }
  while (
    meanStart < meanHist.length - 1 &&
    meanCoveredUs - meanHist[meanStart] >= MEAN_KEEP_US
  ) {
    meanCoveredUs -= meanHist[meanStart];
    meanStart++;
  }
  while (meanStart < meanHist.length - 1 && meanHist.length - meanStart > MEAN_MAX_SAMPLES) {
    meanCoveredUs -= meanHist[meanStart];
    meanStart++;
  }
  if (meanStart > 2048) {
    meanHist = meanHist.slice(meanStart);
    meanStart = 0;
  }
}

/** Moyenne des impulsions qui couvrent les `windowMs` dernières millisecondes. */
function recentMean(windowMs) {
  const end = meanHist.length;
  if (end <= meanStart) return NaN;
  const budgetUs = Math.max(windowMs, 1) * 1000;
  let sum = 0;
  let coveredUs = 0;
  let n = 0;
  for (let i = end - 1; i >= meanStart; i--) {
    const v = meanHist[i];
    sum += v;
    coveredUs += v;
    n++;
    if (coveredUs >= budgetUs) break;
  }
  return n ? sum / n : NaN;
}

/** Centre visé par le centrage auto : moyenne des X dernières secondes. */
function autoCenterValue() {
  const mean = recentMean(G.zoomSmoothMs);
  if (Number.isFinite(mean)) return mean;
  const [lo, hi] = visibleMinMax();
  return (lo + hi) / 2;
}

/** Demi-plage qui contient les données visibles autour de `center`, plus la marge. */
function autoZoomHalf(center) {
  const [lo, hi] = visibleMinMax();
  let dataSpan = hi - lo;
  if (!Number.isFinite(dataSpan) || dataSpan < 1) dataSpan = MIN_ZOOM_RANGE;
  const pad = Math.max(dataSpan * (G.zoomMarginPct / 100), 2);
  let half = Math.max(center - lo, hi - center) + pad;
  if (half * 2 < MIN_ZOOM_RANGE) half = MIN_ZOOM_RANGE / 2;
  if (half * 2 > MAX_ZOOM_RANGE) half = MAX_ZOOM_RANGE / 2;
  return half;
}

function frameHalf(center) {
  if (G.autoZoom) return autoZoomHalf(center);
  if (isViewReady()) return (globalMax - globalMin) / 2;
  return autoZoomHalf(center);
}

function snapAutoFrame() {
  if (history.length < 2) return;
  const center = G.autoCenter || !isViewReady()
    ? autoCenterValue()
    : (globalMin + globalMax) / 2;
  if (!Number.isFinite(center)) return;
  const half = frameHalf(center);
  if (G.autoZoom) zoomHalf = half;
  globalMin = Math.round(center - half);
  globalMax = Math.round(center + half);
  viewFitted = true;
  needStatsFlush = true;
}

/** Colle l'échelle Y aux impulsions visibles, sur toute la hauteur du canevas. */
function fitVerticalView(lo, hi) {
  let span = hi - lo;
  if (!Number.isFinite(span) || span < 1) span = MIN_ZOOM_RANGE;
  // ~2 % : le trait ne colle pas au bord, sans laisser une bande vide.
  const pad = Math.max(span * 0.02, 2);
  globalMin = Math.round(lo - pad);
  globalMax = Math.round(hi + pad);
  if (globalMax - globalMin < MIN_ZOOM_RANGE) {
    const center = (globalMin + globalMax) / 2;
    globalMin = Math.round(center - MIN_ZOOM_RANGE / 2);
    globalMax = Math.round(center + MIN_ZOOM_RANGE / 2);
  }
}

function recenterView() {
  if (history.length < 2) {
    dbgLog("WARN", "VIEW", "Pas assez d'impulsions pour recentrer");
    return;
  }
  const [lo, hi] = visibleMinMax();
  fitVerticalView(lo, hi);
  if (G.autoZoom) zoomHalf = (globalMax - globalMin) / 2;
  if (!G.dynamicThresholds) {
    const range = viewRange();
    threshLo = Math.round(globalMin + range / 3);
    threshHi = Math.round(globalMin + 2 * range / 3);
  } else {
    dynCenter = (lo + hi) / 2;
  }
  viewFitted = true;
  _lblHiCache = { top: -99999, text: "" };
  _lblLoCache = { top: -99999, text: "" };
  currentZone = "";
  zoneHoldUntil = 0;
  needStatsFlush = true;
  requestGraphRedraw();
  dbgLog("INFO", "VIEW", "Recentrage", { n: history.length - visibleStart(), globalMin, globalMax, threshLo, threshHi });
}

const $ = id => document.getElementById(id);

// ─── Debug journal ───
const DBG_MAX_LINES = 120;
let debugOpen = false;
const dbgLines = [];
let dbgBatchCount = 0;
let dbgHeartbeatId = null;
let dbgLastAnomalyLog = 0;
let dbgDrawSkipLog = 0;
let dbgGlitchBatchCount = 0;

function toggleDebug(force) {
  debugOpen = typeof force === "boolean" ? force : !debugOpen;
  $("debugPanel").classList.toggle("open", debugOpen);
  const toggle = $("debugToggle");
  if (toggle) toggle.checked = debugOpen;
  if (debugOpen) {
    if (dbgLines.length === 0) {
      dbgLog("INFO", "DEBUG", "Journal actif — touchez la plante et observez ERR/WARN/STALL");
    }
    dbgRender();
  }
}

function dbgNow() {
  const d = new Date();
  return d.toLocaleTimeString("fr-FR", { hour12: false })
    + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function dbgRender() {
  const el = $("debugPanel");
  if (!el || !debugOpen) return;
  el.innerHTML = dbgLines.map((l) => {
    const cls = l.level === "ERR" ? "line-err" : l.level === "WARN" ? "line-warn" : l.level === "beat" ? "line-beat" : "";
    return `<div class="${cls}">${l.text}</div>`;
  }).join("");
  el.scrollTop = el.scrollHeight;
}

function dbgLog(level, tag, msg, detail) {
  let extra = "";
  if (detail != null) {
    extra = typeof detail === "object" ? " " + JSON.stringify(detail) : " " + detail;
  }
  const text = `[${dbgNow()}] ${level} ${tag}: ${msg}${extra}`;
  dbgLines.push({ level, text });
  if (dbgLines.length > DBG_MAX_LINES) dbgLines.shift();
  if (level === "ERR") console.error(`[${tag}]`, msg, detail ?? "");
  else if (level === "WARN") console.warn(`[${tag}]`, msg, detail ?? "");
  else console.log(`[${tag}]`, msg, detail ?? "");
  dbgRender();
}

function dbgError(tag, err) {
  dbgLog("ERR", tag, err?.message || String(err), err?.stack?.split("\n")[1]?.trim());
}

function dbgStartHeartbeat() {
  dbgStopHeartbeat();
  dbgHeartbeatId = setInterval(() => {
    const sinceMsg = lastStreamMsg ? Math.round(performance.now() - lastStreamMsg) : -1;
    dbgLog("beat", "HEART", [
      `sse=${stream ? stream.readyState : -1}`,
      `lastMsg=${sinceMsg}ms`,
      `seq=${lastSeq}`,
      `batches=${dbgBatchCount}`,
      `glitchBatches=${dbgGlitchBatchCount}`,
      `dropped=${lastDroppedCount}`,
      `audio=${audioEnabled ? "on" : "off"}`,
      `view=${isViewReady() ? globalMin + "…" + globalMax : "n/a"}`,
      `hist=${history.length}`,
      `avg=${lastBatchAvg}`,
      `zone=${currentZone || "?"}`,
    ].join(" "));
    if (streamLive && sinceMsg > STREAM_STALE_MS) {
      dbgLog("WARN", "STALL", `Aucun message du Pico depuis ${sinceMsg} ms`);
    }
  }, 2000);
}

function dbgStopHeartbeat() {
  if (dbgHeartbeatId != null) {
    clearInterval(dbgHeartbeatId);
    dbgHeartbeatId = null;
  }
}

function dbgNoteSignalAnomaly(rawN, intervals, batchMin, batchMax) {
  if (performance.now() - dbgLastAnomalyLog < 350) return;
  dbgLastAnomalyLog = performance.now();
  const aboveView = isViewReady() && batchMax > globalMax;
  const belowView = isViewReady() && batchMin < globalMin;
  const aboveThresh = batchMax > threshHi;
  const belowThresh = batchMin < threshLo;
  if (!aboveView && !belowView && !aboveThresh && !belowThresh) return;
  dbgLog("INFO", "SIGNAL", "Pic ou interaction détecté", {
    rawN,
    n: intervals.length,
    batchMin,
    batchMax,
    avg: lastBatchAvg,
    view: isViewReady() ? [globalMin, globalMax] : null,
    thresh: [threshLo, threshHi],
    aboveView,
    belowView,
    aboveThresh,
    belowThresh,
    last: intervals[intervals.length - 1],
  });
}

let graphCanvas2d = null;
function getGraphContext() {
  const c = $("graph");
  if (!graphCanvas2d) {
    graphCanvas2d = c.getContext("2d", { alpha: true });
  }
  return graphCanvas2d;
}

// ─── Configurable parameters (driven by settings sliders) ───
const P_SPEC = {
  masterVol: { min: 0, max: 100, def: 50 },
  ambientVol: { min: 0, max: 100, def: 45 },
  vegetalVol: { min: 0, max: 100, def: 55 },
  interVol: { min: 0, max: 100, def: 60 },
  bpm: { min: 20, max: 160, def: 60 },
};

const P = {
  masterVol: P_SPEC.masterVol.def,
  ambientVol: P_SPEC.ambientVol.def,
  vegetalVol: P_SPEC.vegetalVol.def,
  interVol: P_SPEC.interVol.def,
  bpm: P_SPEC.bpm.def,
};

const MOD_SMOOTH_MAX = 10;
const DEFAULT_MOD_SMOOTH = 0.3;
const DEFAULT_MOD_AMOUNT = 75;
const DEFAULT_MOD_SENSE = 60;
const DEFAULT_MOD_MOTION = 45;
const ROLE_MOD_DEFAULTS = {
  ambiance: { modSmooth: 0.8, modAmount: 70, modSense: 45, modMotion: 35, modInvert: false },
  vegetal: { modSmooth: 0.3, modAmount: 80, modSense: 70, modMotion: 50, modInvert: false },
  interaction: { modSmooth: 0.1, modAmount: 85, modSense: 75, modMotion: 40, modInvert: false },
};
let legacyModSmooth = DEFAULT_MOD_SMOOTH;
let legacyModAmount = DEFAULT_MOD_AMOUNT;
const PARAM_RESET_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M3.2 8A4.8 4.8 0 1 0 4.6 4.6M3.2 2.8v2.6h2.6"/></svg>';

const SON_KEY = "plante-son-v1";
const smoothedT01 = { ambiance: 0.5, vegetal: 0.5, interaction: 0 };
const slowT01 = { ambiance: 0.5, vegetal: 0.5, interaction: 0 };
let lastModTick = 0;
let modRafId = null;
let lastLinkedUiSync = 0;
let lastAudioRecover = 0;
let audioRecovering = false;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const SPARKLE_THRESH_US = 1000;

function roleModDef(role, key) {
  const d = ROLE_MOD_DEFAULTS[role] || ROLE_MOD_DEFAULTS.vegetal;
  return d[key];
}

function migrateModSmooth(v, fallback) {
  const fb = Number.isFinite(fallback) ? fallback : DEFAULT_MOD_SMOOTH;
  if (!Number.isFinite(v)) return fb;
  const sec = v > MOD_SMOOTH_MAX
    ? 0.08 * Math.pow(75, clamp(v, 0, 100) / 100)
    : v;
  return clamp(Math.round(sec * 10) / 10, 0, MOD_SMOOTH_MAX);
}

function roleModSmooth(role) {
  const v = routing[role] && routing[role].modSmooth;
  return Number.isFinite(v) ? migrateModSmooth(v, roleModDef(role, "modSmooth")) : roleModDef(role, "modSmooth");
}

function roleModAmount(role) {
  const v = routing[role] && routing[role].modAmount;
  return Number.isFinite(v) ? clamp(v, 0, 100) : roleModDef(role, "modAmount");
}

function roleModSense(role) {
  const v = routing[role] && routing[role].modSense;
  return Number.isFinite(v) ? clamp(v, 0, 100) : roleModDef(role, "modSense");
}

function roleModMotion(role) {
  const v = routing[role] && routing[role].modMotion;
  return Number.isFinite(v) ? clamp(v, 0, 100) : roleModDef(role, "modMotion");
}

function roleModInvert(role) {
  return !!(routing[role] && routing[role].modInvert);
}

function roleShapedT01(role, t01) {
  let t = clamp(t01, 0, 1);
  if (roleModInvert(role)) t = 1 - t;
  return t;
}

function smoothTauSec(slider) {
  return clamp(slider ?? DEFAULT_MOD_SMOOTH, 0, MOD_SMOOTH_MAX);
}

function formatSmooth(slider) {
  const sec = smoothTauSec(slider);
  if (sec <= 0) return "0 s";
  if (sec < 1) return Math.round(sec * 1000) + " ms";
  return (Math.round(sec * 10) / 10).toString().replace(".", ",") + " s";
}

function formatParamVal(key, raw) {
  switch (key) {
    case "masterVol": case "ambientVol":
    case "vegetalVol": case "interVol":
    case "modAmount": case "modSense": case "modMotion": return raw + "%";
    case "modSmooth": return formatSmooth(raw);
    case "bpm": return String(raw);
    default: return String(raw);
  }
}

function formatInstParam(spec, raw) {
  if (!spec) return String(raw);
  if (spec.freq) return Math.round(raw) + " Hz";
  const span = spec.max - spec.min;
  if (span <= 1.01) return Math.round(raw * 100) + "%";
  if (span <= 12) return (Math.round(raw * 10) / 10).toString();
  return String(Math.round(raw));
}

const FAUST_PATCHES = (window.FAUST_CATALOG && window.FAUST_CATALOG.patches) || [];
const INST = {};
for (let i = 0; i < FAUST_PATCHES.length; i++) {
  const patch = FAUST_PATCHES[i];
  INST[patch.id] = {
    label: patch.label,
    kind: "faust",
    group: "faust",
    params: patch.params,
    defaultParam: patch.defaultParam,
    level: patch.level || 0.38,
  };
}

const ROLE_META = {
  ambiance: { title: "Ambiance", blurb: "Toute la hauteur du graphique, plus l’agitation globale." },
  vegetal: { title: "Végétal", blurb: "Le centre, entre les seuils : les petits mouvements y sont très sensibles." },
  interaction: { title: "Toucher", blurb: "Ce qui dépasse les seuils, surtout les attaques." },
};

const ROUTING_KEY = "plante-mix-v2";
const CONFIG_KEY = "plante-config-v3";
const CONFIG_COOKIE = "plantecfg";
const CONFIG_VERSION = 4;
const SETTINGS_URL = "/api/settings";
const TITLE_MAX = 80;
const ROLE_VOL = { ambiance: "ambientVol", vegetal: "vegetalVol", interaction: "interVol" };
const ROLE_IDS = ["ambiance", "vegetal", "interaction"];

function defaultRoleMod(role) {
  const d = ROLE_MOD_DEFAULTS[role] || ROLE_MOD_DEFAULTS.vegetal;
  return {
    modSmooth: d.modSmooth,
    modAmount: d.modAmount,
    modSense: d.modSense,
    modMotion: d.modMotion,
    modInvert: d.modInvert,
  };
}

const defaultRouting = () => ({
  ambiance: Object.assign({ on: true, inst: "sine-drone", param: "freq1", vals: {}, instruments: {} }, defaultRoleMod("ambiance")),
  vegetal: Object.assign({ on: true, inst: "wind-chimes", param: "density", vals: {}, instruments: {} }, defaultRoleMod("vegetal")),
  interaction: Object.assign({ on: true, inst: "wind-bells", param: "density", vals: {}, instruments: {} }, defaultRoleMod("interaction")),
});

let routing = defaultRouting();
let configTitle = "";
let uiRole = "vegetal";
let audioEnabled = false;
let ambMean = 20000;
let ambVar = 40;
let ambVarFast = 40;
let prevInterval = 20000;

function clampMixKey(key, raw) {
  const spec = P_SPEC[key];
  if (!spec || !Number.isFinite(raw)) return spec ? spec.def : raw;
  return clamp(raw, spec.min, spec.max);
}

function sanitizeInstVals(instId, vals) {
  const out = {};
  if (!vals || typeof vals !== "object") return out;
  for (const p of instParams(instId)) {
    const v = vals[p.id];
    if (Number.isFinite(v)) out[p.id] = clamp(v, p.min, p.max);
  }
  return out;
}

function sanitizeInstMemory(role, instId, raw) {
  const spec = INST[instId];
  if (!spec) return null;
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    param: isRoleLinkParam(role, src.param, spec) ? src.param : spec.defaultParam,
    vals: sanitizeInstVals(instId, src.vals),
  };
}

function applyRolePatch(target, role, src) {
  if (!src || typeof src !== "object") return;
  if (typeof src.on === "boolean") target.on = src.on;
  if (INST[src.inst]) target.inst = src.inst;
  const spec = INST[target.inst];
  if (!spec) return;
  target.param = isRoleLinkParam(role, src.param, spec) ? src.param : spec.defaultParam;
  target.vals = sanitizeInstVals(target.inst, src.vals);
  applyRoleModPatch(target, role, src);
  target.instruments = target.instruments || {};
  const instMap = src.instruments && typeof src.instruments === "object" ? src.instruments : {};
  for (const instId of Object.keys(instMap)) {
    const mem = sanitizeInstMemory(role, instId, instMap[instId]);
    if (mem) target.instruments[instId] = mem;
  }
  const currentMem = target.instruments[target.inst] || { param: target.param, vals: {} };
  target.instruments[target.inst] = {
    param: target.param,
    vals: Object.assign({}, currentMem.vals, target.vals),
  };
  target.vals = Object.assign({}, target.instruments[target.inst].vals);
}

function applyRoleModPatch(target, role, src) {
  const defs = defaultRoleMod(role);
  if (!src || typeof src !== "object") {
    target.modSmooth = defs.modSmooth;
    target.modAmount = defs.modAmount;
    target.modSense = defs.modSense;
    target.modMotion = defs.modMotion;
    target.modInvert = defs.modInvert;
    return;
  }
  const hasNew = Number.isFinite(src.modSense) || Number.isFinite(src.modMotion);
  if (hasNew) {
    target.modSmooth = Number.isFinite(src.modSmooth)
      ? migrateModSmooth(src.modSmooth, defs.modSmooth)
      : defs.modSmooth;
    target.modAmount = Number.isFinite(src.modAmount) ? clamp(src.modAmount, 0, 100) : defs.modAmount;
    target.modSense = Number.isFinite(src.modSense) ? clamp(src.modSense, 0, 100) : defs.modSense;
    target.modMotion = Number.isFinite(src.modMotion) ? clamp(src.modMotion, 0, 100) : defs.modMotion;
    target.modInvert = typeof src.modInvert === "boolean" ? src.modInvert : defs.modInvert;
    return;
  }
  const oldSmooth = Number.isFinite(src.modSmooth) ? migrateModSmooth(src.modSmooth, 0.7) : 0.7;
  const oldAmount = Number.isFinite(src.modAmount) ? clamp(src.modAmount, 0, 100) : 40;
  target.modSmooth = Math.abs(oldSmooth - 0.7) < 0.05 ? defs.modSmooth : oldSmooth;
  target.modAmount = oldAmount === 40 ? defs.modAmount : oldAmount;
  target.modSense = defs.modSense;
  target.modMotion = defs.modMotion;
  target.modInvert = typeof src.modInvert === "boolean" ? src.modInvert : defs.modInvert;
}

function applyMixPatch(src) {
  if (!src || typeof src !== "object") return;
  for (const key of Object.keys(P_SPEC)) {
    if (Number.isFinite(src[key])) P[key] = clampMixKey(key, src[key]);
  }
  if (!Number.isFinite(src.bpm) && Number.isFinite(src.bpmMax)) P.bpm = clampMixKey("bpm", src.bpmMax);
}

function routingFromParsed(parsed) {
  const next = defaultRouting();
  if (!parsed || typeof parsed !== "object") return next;
  const roles = parsed.roles && typeof parsed.roles === "object" ? parsed.roles : parsed;
  for (const role of ROLE_IDS) applyRolePatch(next[role], role, roles[role]);
  return next;
}

function sanitizeTitle(value) {
  return String(value || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, TITLE_MAX);
}

function applyConfigObject(parsed, opts) {
  if (!parsed || typeof parsed !== "object") return false;
  configTitle = typeof parsed.title === "string" ? sanitizeTitle(parsed.title) : "";
  if (Number.isFinite(parsed.modSmooth)) legacyModSmooth = migrateModSmooth(parsed.modSmooth);
  if (Number.isFinite(parsed.modAmount)) legacyModAmount = clamp(parsed.modAmount, 0, 100);
  applyMixPatch(parsed.mix || parsed);
  if (parsed.display && typeof parsed.display.graphAnimations === "boolean") {
    graphAnimations = parsed.display.graphAnimations;
    graphAnimFromConfig = true;
  } else if (typeof parsed.graphAnimations === "boolean") {
    graphAnimations = parsed.graphAnimations;
    graphAnimFromConfig = true;
  }
  const general = parsed.general && typeof parsed.general === "object" ? parsed.general : parsed.display;
  if (general && typeof general === "object") {
    if (typeof general.dynamicThresholds === "boolean") G.dynamicThresholds = general.dynamicThresholds;
    if (Number.isFinite(general.threshMarginPct)) {
      G.threshMarginPct = clamp(general.threshMarginPct, G_SPEC.threshMarginPct.min, G_SPEC.threshMarginPct.max);
    }
    if (Number.isFinite(general.threshSmoothMs)) {
      G.threshSmoothMs = clamp(general.threshSmoothMs, G_SPEC.threshSmoothMs.min, G_SPEC.threshSmoothMs.max);
    }
    if (Number.isFinite(general.zoomMarginPct)) {
      G.zoomMarginPct = clamp(general.zoomMarginPct, G_SPEC.zoomMarginPct.min, G_SPEC.zoomMarginPct.max);
    }
    if (Number.isFinite(general.zoomSmoothMs)) {
      G.zoomSmoothMs = clamp(general.zoomSmoothMs, G_SPEC.zoomSmoothMs.min, G_SPEC.zoomSmoothMs.max);
    }
    if (Number.isFinite(general.zoneXfadeMs)) {
      G.zoneXfadeMs = clamp(general.zoneXfadeMs, G_SPEC.zoneXfadeMs.min, G_SPEC.zoneXfadeMs.max);
    }
    if (typeof general.zoneXfade === "boolean") G.zoneXfade = general.zoneXfade;
    if (typeof general.autoZoom === "boolean") G.autoZoom = general.autoZoom;
    if (typeof general.autoCenter === "boolean") G.autoCenter = general.autoCenter;
    else if (typeof general.autoZoom === "boolean") G.autoCenter = general.autoZoom;
  }
  const display = parsed.display && typeof parsed.display === "object" ? parsed.display : null;
  const generalHasZoom = general && typeof general.autoZoom === "boolean";
  const generalHasCenter = general && typeof general.autoCenter === "boolean";
  if (display && !generalHasZoom && typeof display.autoZoom === "boolean") {
    G.autoZoom = display.autoZoom;
    if (!generalHasCenter && typeof display.autoCenter !== "boolean") G.autoCenter = display.autoZoom;
  }
  if (display && !generalHasCenter && typeof display.autoCenter === "boolean") {
    G.autoCenter = display.autoCenter;
  }
  if (G.dynamicThresholds) dynCenter = (threshLo + threshHi) / 2;
  const roleSrc = parsed.roles || ((parsed.ambiance || parsed.vegetal || parsed.interaction) ? parsed : parsed.active);
  if (roleSrc) routing = routingFromParsed(roleSrc);
  if (opts && opts.sync) syncAppliedConfig();
  return true;
}

function readCookie(name) {
  const parts = document.cookie.split("; ");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf(name + "=") === 0) {
      return decodeURIComponent(parts[i].slice(name.length + 1));
    }
  }
  return "";
}

function writeCookie(name, value) {
  const encoded = encodeURIComponent(value);
  if (encoded.length > 3500) return false;
  document.cookie = name + "=" + encoded + ";max-age=31536000;path=/;SameSite=Lax";
  return true;
}

function clearCookie(name) {
  document.cookie = name + "=;max-age=0;path=/;SameSite=Lax";
}

function loadLegacySettings() {
  try {
    const rawSon = localStorage.getItem(SON_KEY);
    if (rawSon) applyConfigObject(JSON.parse(rawSon));
  } catch (_) { /* stockage indisponible */ }
  try {
    const rawMix = localStorage.getItem(ROUTING_KEY);
    if (rawMix) routing = routingFromParsed(JSON.parse(rawMix));
  } catch (_) { /* stockage indisponible */ }
}

function loadPersistedConfig() {
  let loaded = false;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) loaded = applyConfigObject(JSON.parse(raw));
  } catch (_) { /* stockage indisponible */ }
  if (!loaded) {
    try {
      const cookieRaw = readCookie(CONFIG_COOKIE);
      if (cookieRaw) loaded = applyConfigObject(JSON.parse(cookieRaw));
    } catch (_) { /* cookie illisible */ }
  }
  if (!loaded) loadLegacySettings();
}

function instStoredVals(role, instId) {
  const r = routing[role];
  if (!r) return {};
  if (r.inst === instId) return r.vals || {};
  const mem = r.instruments && r.instruments[instId];
  return (mem && mem.vals) || {};
}

function instStoredParam(role, instId) {
  const r = routing[role];
  const spec = INST[instId];
  if (!r || !spec) return spec ? spec.defaultParam : null;
  if (r.inst === instId) return r.param;
  const mem = r.instruments && r.instruments[instId];
  if (mem && isRoleLinkParam(role, mem.param, spec)) return mem.param;
  return spec.defaultParam;
}

function defaultInstParamValue(role, instId, paramId) {
  const spec = paramSpec(instId, paramId);
  if (!spec) return 0;
  if (Number.isFinite(spec.def)) return spec.def;
  return (spec.min + spec.max) * 0.5;
}

function exportedInstVals(role, instId, complete) {
  const stored = instStoredVals(role, instId);
  if (!complete) return Object.assign({}, stored);
  const vals = {};
  for (const p of instParams(instId)) {
    const raw = Number.isFinite(stored[p.id])
      ? clamp(stored[p.id], p.min, p.max)
      : defaultInstParamValue(role, instId, p.id);
    vals[p.id] = Math.round(raw * 1000) / 1000;
  }
  return vals;
}

function stashRoleInstrument(role) {
  const r = routing[role];
  if (!r || !INST[r.inst]) return;
  r.instruments = r.instruments || {};
  r.instruments[r.inst] = {
    param: r.param,
    vals: Object.assign({}, r.vals || {}),
  };
}

function applyInstrumentMemory(role, instId) {
  const r = routing[role];
  const spec = INST[instId];
  if (!r || !spec) return;
  r.instruments = r.instruments || {};
  const mem = r.instruments[instId] || {};
  r.inst = instId;
  r.param = isRoleLinkParam(role, mem.param, spec) ? mem.param : spec.defaultParam;
  r.vals = sanitizeInstVals(instId, mem.vals);
}

function serializeConfig(opts) {
  const complete = !!(opts && opts.complete);
  for (const role of ROLE_IDS) stashRoleInstrument(role);
  const roles = {};
  for (const role of ROLE_IDS) {
    const r = routing[role];
    const instruments = {};
    const ids = complete ? Object.keys(INST) : Object.keys(r.instruments || {});
    if (ids.indexOf(r.inst) === -1) ids.push(r.inst);
    for (let i = 0; i < ids.length; i++) {
      const instId = ids[i];
      if (!INST[instId]) continue;
      instruments[instId] = {
        param: instStoredParam(role, instId),
        vals: exportedInstVals(role, instId, complete),
      };
    }
    roles[role] = {
      on: !!r.on,
      inst: r.inst,
      param: r.param,
      modSmooth: roleModSmooth(role),
      modAmount: roleModAmount(role),
      modSense: roleModSense(role),
      modMotion: roleModMotion(role),
      modInvert: roleModInvert(role),
      vals: Object.assign({}, r.vals || {}),
      instruments,
    };
  }
  return {
    version: CONFIG_VERSION,
    app: "plante-musicale",
    title: configTitle.trim(),
    mix: Object.assign({}, P),
    display: { graphAnimations: !!graphAnimations, autoCenter: !!G.autoCenter, autoZoom: !!G.autoZoom },
    general: {
      dynamicThresholds: !!G.dynamicThresholds,
      threshMarginPct: G.threshMarginPct,
      threshSmoothMs: G.threshSmoothMs,
      zoomMarginPct: G.zoomMarginPct,
      zoomSmoothMs: G.zoomSmoothMs,
      zoneXfadeMs: G.zoneXfadeMs,
      zoneXfade: !!G.zoneXfade,
      autoCenter: !!G.autoCenter,
      autoZoom: !!G.autoZoom,
    },
    active: ROLE_IDS.reduce((acc, role) => {
      const r = roles[role];
      acc[role] = { on: r.on, inst: r.inst, param: r.param, modSmooth: r.modSmooth, modAmount: r.modAmount, modSense: r.modSense, modMotion: r.modMotion, modInvert: r.modInvert };
      return acc;
    }, {}),
    roles,
  };
}

let localRevision = 0;
let picoPresets = [];
let activePresetId = "";
let pendingDeleteId = "";
let pendingDeleteTimer = null;
let picoReachable = false;

function writeLocalConfig(full) {
  const fullJson = JSON.stringify(full);
  try { localStorage.setItem(CONFIG_KEY, fullJson); } catch (_) { /* quota */ }
  const cookieJson = JSON.stringify({
    version: CONFIG_VERSION,
    title: full.title,
    mix: full.mix,
    display: full.display,
    general: full.general,
    roles: ROLE_IDS.reduce((acc, role) => {
      const r = full.roles[role];
      acc[role] = {
        on: r.on,
        inst: r.inst,
        param: r.param,
        modSmooth: r.modSmooth,
        modAmount: r.modAmount,
        modSense: r.modSense,
        modMotion: r.modMotion,
        modInvert: r.modInvert,
        vals: r.vals,
      };
      return acc;
    }, {}),
  });
  if (!writeCookie(CONFIG_COOKIE, cookieJson)) {
    const compact = JSON.stringify({
      version: CONFIG_VERSION,
      title: full.title,
      mix: full.mix,
      active: full.active,
    });
    if (!writeCookie(CONFIG_COOKIE, compact)) clearCookie(CONFIG_COOKIE);
  }
}

function setFilesStatus(text, kind) {
  const el = $("filesStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-ok", "is-warn", "is-error");
  if (kind) el.classList.add(kind);
}

function picoSaveError(err, status, detail) {
  if (status === 405 || status === 501) {
    return "Le Pico n'accepte pas encore l'enregistrement. Relancez le déploiement.";
  }
  if (status === 507) return detail || "Plus de place sur le Pico.";
  if (status === 413) return "Réglages trop volumineux pour le Pico.";
  if (status === 400) return detail || "Le Pico a refusé ces réglages.";
  if (status) return detail || ("Le Pico a répondu " + status + ".");
  return "Le Pico a coupé la connexion pendant l'enregistrement.";
}

function syncTitleInput() {
  const input = $("cfgTitle");
  if (!input || document.activeElement === input) return;
  input.value = configTitle;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function presetTitle() {
  const title = configTitle.trim();
  return title || "Sans titre";
}

function selectedPreset() {
  return picoPresets.find((preset) => preset.id === activePresetId) || null;
}

function saveUpdatesSelection() {
  const current = selectedPreset();
  return !!(current && current.title === presetTitle());
}

function updateSaveLabel() {
  const btn = $("cfgPicoSave");
  if (!btn) return;
  btn.textContent = saveUpdatesSelection() ? "Mettre à jour" : "Enregistrer sur le Pico";
}

function picoListStatus() {
  const count = picoPresets.length;
  if (!count) return ["Aucun réglage sur le Pico", ""];
  if (activePresetId) return ["Réglage chargé", "is-ok"];
  return [count === 1 ? "1 réglage sur le Pico" : count + " réglages sur le Pico", ""];
}

function applyPresetSummary(summary) {
  const list = Array.isArray(summary && summary.presets) ? summary.presets : [];
  picoPresets = list.map((preset) => ({
    id: String(preset && preset.id != null ? preset.id : ""),
    title: (preset && preset.title) || "Sans titre",
  })).filter((preset) => preset.id);
  if (activePresetId && !picoPresets.some((preset) => preset.id === activePresetId)) {
    activePresetId = "";
  }
  if (pendingDeleteId && !picoPresets.some((preset) => preset.id === pendingDeleteId)) {
    pendingDeleteId = "";
  }
  renderPresetList();
}

function clearPendingDelete() {
  clearTimeout(pendingDeleteTimer);
  pendingDeleteTimer = null;
  if (!pendingDeleteId) return;
  pendingDeleteId = "";
  renderPresetList();
}

function renderPresetList() {
  const list = $("cfgPresetList");
  if (!list) return;
  updateSaveLabel();
  if (!picoReachable) {
    list.innerHTML = '<li class="preset-empty">Liste indisponible</li>';
    return;
  }
  if (!picoPresets.length) {
    list.innerHTML = '<li class="preset-empty">Aucun réglage sur le Pico</li>';
    return;
  }
  list.innerHTML = picoPresets.map((preset) => {
    const title = escapeHtml(preset.title || "Sans titre");
    const id = escapeHtml(preset.id);
    const active = preset.id === activePresetId ? " is-active" : "";
    const armed = preset.id === pendingDeleteId;
    const delClass = armed ? "preset-delete is-armed" : "preset-delete";
    const delText = armed ? "Suppr." : "×";
    return `<li class="preset-row${active}">` +
      `<button type="button" class="preset-load" data-preset-id="${id}">${title}</button>` +
      `<button type="button" class="${delClass}" data-preset-id="${id}" aria-label="Supprimer ${title}">${delText}</button>` +
      `</li>`;
  }).join("");
}

async function postSettings(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: body == null ? "" : body,
  });
  const detail = (await res.text()).trim();
  if (!res.ok) {
    const error = new Error("HTTP " + res.status);
    error.status = res.status;
    error.detail = detail;
    throw error;
  }
  return detail ? JSON.parse(detail) : {};
}

async function savePicoSettings() {
  clearPendingDelete();
  const title = presetTitle();
  configTitle = title;
  syncTitleInput();
  const payload = serializeConfig({ complete: false });
  payload.title = title;
  if (saveUpdatesSelection()) payload.id = String(activePresetId);
  setFilesStatus("Enregistrement…", "");
  try {
    const summary = await postSettings(SETTINGS_URL, JSON.stringify(payload));
    picoReachable = true;
    activePresetId = summary.id != null ? String(summary.id) : "";
    applyPresetSummary(summary);
    writeLocalConfig(serializeConfig({ complete: false }));
    setFilesStatus("Enregistré sur le Pico", "is-ok");
  } catch (err) {
    dbgError("CFG", err);
    setFilesStatus(picoSaveError(err, err && err.status, err && err.detail), "is-error");
  }
}

async function loadPicoPreset(id) {
  clearPendingDelete();
  const wanted = String(id);
  setFilesStatus("Chargement…", "");
  try {
    const res = await fetch(SETTINGS_URL + "?id=" + encodeURIComponent(wanted), { cache: "no-store" });
    const detail = (await res.text()).trim();
    if (!res.ok) {
      const error = new Error("HTTP " + res.status);
      error.status = res.status;
      error.detail = detail;
      throw error;
    }
    const parsed = detail ? JSON.parse(detail) : null;
    if (!applyConfigObject(parsed, { sync: true })) throw new Error("config");
    activePresetId = wanted;
    picoReachable = true;
    writeLocalConfig(serializeConfig({ complete: false }));
    renderPresetList();
    setFilesStatus("Réglage chargé", "is-ok");
  } catch (err) {
    dbgError("CFG", err);
    const status = err && err.status;
    setFilesStatus(
      status === 404
        ? "Ce réglage n'est plus sur le Pico."
        : picoSaveError(err, status, err && err.detail),
      "is-error"
    );
    return;
  }
  try {
    const summary = await postSettings(SETTINGS_URL + "?id=" + encodeURIComponent(wanted), "");
    if (summary && Array.isArray(summary.presets)) applyPresetSummary(summary);
  } catch (_) { /* le réglage est déjà appliqué */ }
}

async function deletePicoPreset(id) {
  const wanted = String(id);
  if (pendingDeleteId !== wanted) {
    clearTimeout(pendingDeleteTimer);
    pendingDeleteId = wanted;
    renderPresetList();
    setFilesStatus("Touchez « Suppr. » pour confirmer.", "is-warn");
    pendingDeleteTimer = setTimeout(() => {
      if (pendingDeleteId !== wanted) return;
      clearPendingDelete();
      const status = picoListStatus();
      setFilesStatus(status[0], status[1]);
    }, 3500);
    return;
  }
  clearPendingDelete();
  try {
    const res = await fetch(SETTINGS_URL + "?id=" + encodeURIComponent(wanted), {
      method: "DELETE",
      cache: "no-store",
    });
    const detail = await res.text();
    if (!res.ok && res.status !== 404) {
      const error = new Error("HTTP " + res.status);
      error.status = res.status;
      error.detail = detail.trim();
      throw error;
    }
    const summary = detail ? JSON.parse(detail) : {};
    if (activePresetId === wanted) activePresetId = "";
    picoReachable = true;
    applyPresetSummary(summary);
    setFilesStatus("Réglage supprimé", "");
  } catch (err) {
    dbgError("CFG", err);
    setFilesStatus(picoSaveError(err, err && err.status, err && err.detail), "is-error");
  }
}

async function loadPicoSettings() {
  const revision = localRevision;
  setFilesStatus("Lecture du Pico…", "");
  try {
    const res = await fetch(SETTINGS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const summary = await res.json();
    if (!summary || !Array.isArray(summary.presets)) {
      picoReachable = false;
      renderPresetList();
      setFilesStatus("Le Pico n'a pas encore la liste des réglages. Relancez le déploiement.", "is-error");
      return;
    }
    picoReachable = true;
    applyPresetSummary(summary);
    const active = summary.active != null && summary.active !== "" ? String(summary.active) : "";
    if (active && localRevision === revision) {
      const cfgRes = await fetch(SETTINGS_URL + "?id=" + encodeURIComponent(active), { cache: "no-store" });
      if (cfgRes.ok && localRevision === revision) {
        const parsed = await cfgRes.json();
        if (applyConfigObject(parsed, { sync: true })) {
          activePresetId = active;
          writeLocalConfig(serializeConfig({ complete: false }));
          renderPresetList();
        }
      }
    }
    const status = picoListStatus();
    setFilesStatus(status[0], status[1]);
  } catch (err) {
    dbgError("CFG", err);
    picoReachable = false;
    renderPresetList();
    setFilesStatus("Liste des réglages indisponible. Le capteur, lui, reste connecté.", "is-error");
  }
}

function persistConfig() {
  localRevision++;
  writeLocalConfig(serializeConfig({ complete: false }));
  updateSaveLabel();
}

function saveSonSettings() { persistConfig(); }
function saveRouting() { persistConfig(); }

function valuesNear(a, b, span) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const eps = span > 20 ? 0.51 : (span > 1.01 ? 0.05 : 0.005);
  return Math.abs(a - b) <= eps;
}

function isResetDefault(kind, id) {
  const role = uiRole;
  if (kind === "mix") {
    const spec = P_SPEC[id];
    return !!(spec && valuesNear(P[id], spec.def, spec.max - spec.min));
  }
  if (kind === "mod") {
    if (id === "modSmooth") return Math.abs(roleModSmooth(role) - roleModDef(role, "modSmooth")) < 0.05;
    if (id === "modAmount") return roleModAmount(role) === roleModDef(role, "modAmount");
    if (id === "modSense") return roleModSense(role) === roleModDef(role, "modSense");
    if (id === "modMotion") return roleModMotion(role) === roleModDef(role, "modMotion");
  }
  if (kind === "inst") {
    const spec = paramSpec(routing[role].inst, id);
    if (!spec) return true;
    const stored = routing[role].vals && routing[role].vals[id];
    if (!Number.isFinite(stored)) return true;
    return valuesNear(stored, defaultInstParamValue(role, routing[role].inst, id), spec.max - spec.min);
  }
  return false;
}

function syncResetButton(btn) {
  if (!btn) return;
  if (!btn.innerHTML) btn.innerHTML = PARAM_RESET_SVG;
  const atDef = isResetDefault(btn.dataset.resetKind, btn.dataset.resetId);
  btn.classList.toggle("is-default", atDef);
  btn.disabled = atDef;
}

function resetParam(kind, id) {
  const role = uiRole;
  if (kind === "mix") {
    if (!P_SPEC[id]) return;
    P[id] = P_SPEC[id].def;
    persistConfig();
    applyParam(id, P[id]);
    document.querySelectorAll(`input[data-param="${id}"]`).forEach((input) => {
      input.value = String(P[id]);
      const valEl = input.closest(".param-row")?.querySelector(".param-val");
      if (valEl) valEl.textContent = formatParamVal(id, P[id]);
    });
    renderRolePanel();
    bindParamResets(document);
    return;
  }
  if (kind === "mod") {
    if (id === "modSmooth") routing[role].modSmooth = roleModDef(role, "modSmooth");
    if (id === "modAmount") routing[role].modAmount = roleModDef(role, "modAmount");
    if (id === "modSense") routing[role].modSense = roleModDef(role, "modSense");
    if (id === "modMotion") routing[role].modMotion = roleModDef(role, "modMotion");
    persistConfig();
    applyLinkedControl(role, smoothedT01[role] ?? roleLinkT01(role), true);
    renderRolePanel();
    return;
  }
  if (kind === "inst") {
    if (routing[role].vals) delete routing[role].vals[id];
    persistConfig();
    applyLinkedControl(role, smoothedT01[role] ?? roleLinkT01(role), true);
    renderRolePanel();
  }
}

function bindParamResets(root) {
  (root || document).querySelectorAll(".param-reset").forEach((btn) => {
    syncResetButton(btn);
    if (btn.dataset.bound === "1") return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled || btn.classList.contains("is-default")) return;
      resetParam(btn.dataset.resetKind, btn.dataset.resetId);
    });
    btn.dataset.bound = "1";
  });
}

function suggestedConfigName() {
  const title = configTitle.trim();
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (slug) return slug + ".json";
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `plante-musicale-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}

function downloadConfigFile(json, filename) {
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function saveConfigFile() {
  const json = JSON.stringify(serializeConfig({ complete: true }), null, 2);
  const suggested = suggestedConfigName();
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: "Configuration Plante Musicale", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  const name = window.prompt("Nom du fichier", suggested);
  if (!name) return;
  downloadConfigFile(json, /\.json$/i.test(name) ? name : name + ".json");
}

function applyLoadedConfig(parsed) {
  if (!parsed || typeof parsed !== "object") throw new Error("Fichier invalide");
  if (parsed.app && parsed.app !== "plante-musicale") {
    throw new Error("Ce fichier n'est pas une configuration Plante Musicale");
  }
  applyConfigObject(parsed, { sync: true });
  persistConfig();
}

async function loadConfigFile() {
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const handles = await window.showOpenFilePicker({
        types: [{ description: "Configuration Plante Musicale", accept: { "application/json": [".json"] } }],
        multiple: false,
      });
      const file = await handles[0].getFile();
      applyLoadedConfig(JSON.parse(await file.text()));
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }
  const input = $("cfgFile");
  if (input) {
    input.value = "";
    input.click();
  }
}

function wireConfigFiles() {
  $("cfgTitle")?.addEventListener("input", (e) => {
    configTitle = String(e.target.value || "").replace(/[\u0000-\u001f]/g, "").slice(0, TITLE_MAX);
    if (e.target.value !== configTitle) e.target.value = configTitle;
    persistConfig();
  });
  $("cfgTitle")?.addEventListener("change", (e) => {
    configTitle = sanitizeTitle(e.target.value);
    e.target.value = configTitle;
    persistConfig();
  });
  $("cfgPresetList")?.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    const id = button.dataset.presetId;
    if (!id) return;
    if (button.classList.contains("preset-delete")) deletePicoPreset(id);
    else loadPicoPreset(id);
  });
  $("cfgPicoSave")?.addEventListener("click", () => {
    savePicoSettings();
  });
  $("cfgSave")?.addEventListener("click", () => {
    saveConfigFile().catch((err) => {
      dbgError("CFG", err);
      window.alert("Impossible d'enregistrer la configuration.");
    });
  });
  $("cfgLoad")?.addEventListener("click", () => {
    loadConfigFile().catch((err) => {
      dbgError("CFG", err);
      window.alert("Impossible de charger ce fichier de configuration.");
    });
  });
  $("cfgFile")?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      applyLoadedConfig(JSON.parse(await file.text()));
    } catch (err) {
      dbgError("CFG", err);
      window.alert("Impossible de lire ce fichier de configuration.");
    }
    e.target.value = "";
  });
}

function syncAppliedConfig() {
  syncParamSlider("masterVol");
  syncParamSlider("bpm");
  try { localStorage.setItem(GRAPH_ANIM_KEY, graphAnimations ? "1" : "0"); } catch (_) { /* quota */ }
  const box = $("graphAnimEnabled");
  if (box) box.checked = graphAnimations;
  document.body.classList.toggle("graph-anim-off", !graphAnimations);
  setThresholdsEnabled(!!routing.interaction.on);
  syncGeneralControls();
  renderRolePanel();
  bindParamResets(document);
  applyAllParams();
  syncTitleInput();
  if (audioEnabled) syncAllRoleAudio();
  requestVisualUpdate();
}

function instParams(id) {
  return (INST[id] && INST[id].params) || [];
}

function paramSpec(instId, paramId) {
  return instParams(instId).find((p) => p.id === paramId) || null;
}

function isRoleLinkParam(role, paramId, spec) {
  if (!paramId) return true;
  const list = spec ? spec.params : instParams(routing[role].inst);
  return list.some((p) => p.id === paramId);
}

function linkedParamLabel(role) {
  return paramSpec(routing[role].inst, routing[role].param)?.label || "";
}

function isFaustKind(id) {
  return !!INST[id];
}

function roleUsesInst(instId) {
  for (const role of Object.keys(routing)) {
    if (routing[role].inst === instId) return role;
  }
  return null;
}

// Wire all sliders
let settingsOpen = false;
let infoOpen = false;
let filesOpen = false;
let aboutOpen = false;

function subPanelOpen() {
  return infoOpen || filesOpen || aboutOpen;
}

function setPanelChrome(panelId, toggleId, open) {
  const panel = $(panelId);
  const toggle = $(toggleId);
  if (panel) {
    panel.classList.toggle("open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  }
  if (toggle) toggle.classList.toggle("active", open);
}

function sessionOpen() {
  return settingsOpen;
}

function updatePanels() {
  setPanelChrome("settingsPanel", "settingsToggle", settingsOpen);
  $("settingsBackdrop").classList.toggle("open", settingsOpen);
  document.body.classList.toggle("settings-open", settingsOpen);
  document.body.classList.toggle("info-open", !!(settingsOpen && infoOpen));
  const rolePanel = $("rolePanel");
  const infoPanel = $("infoPanel");
  const filesPanel = $("filesPanel");
  const aboutPanel = $("aboutPanel");
  if (rolePanel) rolePanel.hidden = subPanelOpen();
  if (infoPanel) infoPanel.hidden = !infoOpen;
  if (filesPanel) filesPanel.hidden = !filesOpen;
  if (aboutPanel) aboutPanel.hidden = !aboutOpen;
  const infoBtn = $("infoToggle");
  if (infoBtn) {
    infoBtn.inert = !settingsOpen;
    infoBtn.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
    infoBtn.classList.toggle("active", settingsOpen && infoOpen);
  }
  const filesBtn = $("filesToggle");
  if (filesBtn) {
    filesBtn.inert = !settingsOpen;
    filesBtn.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
    filesBtn.classList.toggle("active", settingsOpen && filesOpen);
  }
  const aboutBtn = $("aboutToggle");
  if (aboutBtn) {
    aboutBtn.inert = !settingsOpen;
    aboutBtn.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
    aboutBtn.classList.toggle("active", settingsOpen && aboutOpen);
  }
  const pips = $("rolePips");
  if (pips) {
    pips.inert = !settingsOpen;
    pips.setAttribute("aria-hidden", settingsOpen ? "false" : "true");
  }
  syncRoleButtons();
  if (settingsOpen && !subPanelOpen()) {
    maybePrefetchFaust();
    unlockAudio();
    syncSensorLinkUi();
  }
  if (settingsOpen && infoOpen) refreshStatusInfo();
  if (settingsOpen && filesOpen) syncTitleInput();
}

function setSettingsOpen(open) {
  settingsOpen = !!open;
  infoOpen = false;
  filesOpen = false;
  aboutOpen = false;
  updatePanels();
}

function toggleSettings() {
  setSettingsOpen(!settingsOpen);
}

function closeSettings() {
  settingsOpen = false;
  infoOpen = false;
  filesOpen = false;
  aboutOpen = false;
  updatePanels();
}

function setInfoOpen(open) {
  if (!settingsOpen && open) settingsOpen = true;
  infoOpen = !!open;
  if (infoOpen) {
    filesOpen = false;
    aboutOpen = false;
  }
  updatePanels();
}

function toggleInfo() {
  if (!settingsOpen) return;
  setInfoOpen(!infoOpen);
}

function setFilesOpen(open) {
  if (!settingsOpen && open) settingsOpen = true;
  filesOpen = !!open;
  if (filesOpen) {
    infoOpen = false;
    aboutOpen = false;
  }
  updatePanels();
}

function toggleFiles() {
  if (!settingsOpen) return;
  setFilesOpen(!filesOpen);
}

function setAboutOpen(open) {
  if (!settingsOpen && open) settingsOpen = true;
  aboutOpen = !!open;
  if (aboutOpen) {
    infoOpen = false;
    filesOpen = false;
  }
  updatePanels();
}

function toggleAbout() {
  if (!settingsOpen) return;
  setAboutOpen(!aboutOpen);
}

function syncParamSlider(key) {
  const input = document.querySelector(`input[data-param="${key}"]`);
  if (!input) return;
  input.value = String(P[key]);
  const valEl = input.closest(".param-row")?.querySelector(".param-val");
  if (valEl) valEl.textContent = formatParamVal(key, P[key]);
  syncResetButton(input.closest(".param-row")?.querySelector(".param-reset"));
}

function bindParamInput(input) {
  if (!input || input.dataset.bound === "1") return;
  const key = input.dataset.param;
  if (!(key in P)) return;
  const valEl = input.closest(".param-row")?.querySelector(".param-val");
  const linked = input.closest(".param-row")?.classList.contains("is-linked");
  const sync = () => {
    const raw = Number(input.value);
    if (!Number.isFinite(raw)) return;
    P[key] = clampMixKey(key, raw);
    if (valEl) valEl.textContent = formatParamVal(key, P[key]);
    persistConfig();
    applyParam(key, P[key]);
    syncResetButton(input.closest(".param-row")?.querySelector(".param-reset"));
  };
  if (!linked) {
    input.value = String(P[key]);
    if (valEl) valEl.textContent = formatParamVal(key, P[key]);
  }
  input.addEventListener("input", sync);
  input.addEventListener("change", sync);
  input.dataset.bound = "1";
}

function bindSliders() {
  document.querySelectorAll("input[type=range][data-param]").forEach(bindParamInput);
}

bindSliders();

function instSelectHtml(selected, enabled = true) {
  const options = Object.keys(INST).map((id) => {
    const used = roleUsesInst(id);
    const mark = used && used !== uiRole ? ` · ${ROLE_META[used].title}` : "";
    return `<option value="${id}"${id === selected ? " selected" : ""}>${INST[id].label}${mark}</option>`;
  }).join("");
  return `<select class="inst-select" id="roleInst" aria-label="Instrument"${enabled ? "" : " disabled"}>${options}</select>`;
}

function paramRowHtml({ id, label, min, max, step, value, formatted, linked, extraAttrs, showLink, resetKind, resetId, labelTitle }) {
  const checked = linked ? " checked" : "";
  const disabled = linked ? " disabled" : "";
  const kind = resetKind || "mix";
  const rid = resetId || id;
  const titleAttr = labelTitle ? ` title="${labelTitle}"` : "";
  const headInner = showLink === false
    ? `<span class="param-label"${titleAttr}>${label}</span>`
    : `<label class="param-link"${titleAttr}><input type="checkbox" data-link-param="${id}"${checked}><span>${label}</span></label>`;
  const reset = `<button type="button" class="param-reset" data-reset-kind="${kind}" data-reset-id="${rid}" title="Valeur par défaut" aria-label="Remettre ${label} à la valeur par défaut">${PARAM_RESET_SVG}</button>`;
  return `<div class="param-row${linked ? " is-linked" : ""}">` +
    `<div class="param-head">${headInner}${reset}</div>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}"${disabled} ${extraAttrs}>` +
    `<span class="param-val">${formatted}</span></div>`;
}

function roleSenseHint(role) {
  if (role === "vegetal") return "Plus haut = les petits mouvements au centre, entre les seuils, remplissent déjà 0–100 %.";
  if (role === "interaction") return "Plus haut = un petit dépassement de seuil suffit à saturer.";
  return "Plus haut = toute la hauteur du graphe n’est plus nécessaire pour saturer.";
}

function roleMotionHint(role) {
  if (role === "vegetal") return "0 = seulement la position au centre. 100 = l’agitation de la plante dans la bande.";
  if (role === "interaction") return "0 = profondeur du dépassement. 100 = l’énergie des pics au-delà des seuils.";
  return "0 = la hauteur sur tout le graphe. 100 = l’agitation de l’ensemble du signal.";
}

function rangeMapHtml(role) {
  return `<div class="range-map" id="rangeMap" data-role="${role}">` +
    `<div class="range-map-track">` +
    `<div class="range-map-band a"></div>` +
    `<div class="range-map-band b"></div>` +
    `<div class="range-map-focus" id="rangeMapFocus"></div>` +
    `</div>` +
    `<div class="range-map-tick lo"></div>` +
    `<div class="range-map-tick hi"></div>` +
    `<div class="range-map-thumb filtered" id="rangeMapThumbMod" title="Valeur filtrée"></div>` +
    `<div class="range-map-thumb" id="rangeMapThumb" title="Signal brut"></div>` +
    `</div>`;
}

function syncSensorLinkUi() {
  const live = $("sensorLiveVal");
  const last = history.length ? history[history.length - 1] : NaN;
  if (live) live.textContent = formatUs(last);
  const map = $("rangeMap");
  const role = (map && map.dataset.role) || uiRole;
  const ratioEl = $("sensorRatioVal");
  const resting = role === "vegetal" && thresholdsEnabled && !roleSignalInZone(role);
  if (ratioEl) {
    ratioEl.textContent = formatRoleRatio(role);
    ratioEl.classList.toggle("is-rest", resting);
  }
  if (!map) return;
  const bands = map.querySelectorAll(".range-map-band");
  const tickLo = map.querySelector(".range-map-tick.lo");
  const tickHi = map.querySelector(".range-map-tick.hi");
  const thumb = $("rangeMapThumb");
  const lo = viewPct(threshLo);
  const hi = viewPct(threshHi);
  if (tickLo) tickLo.style.left = lo + "%";
  if (tickHi) tickHi.style.left = hi + "%";
  const showTicks = thresholdsEnabled;
  if (tickLo) tickLo.style.display = showTicks ? "" : "none";
  if (tickHi) tickHi.style.display = showTicks ? "" : "none";
  if (role === "ambiance" || !thresholdsEnabled) {
    if (bands[0]) { bands[0].style.left = "0%"; bands[0].style.width = "100%"; }
    if (bands[1]) { bands[1].style.width = "0%"; }
  } else if (role === "vegetal") {
    if (bands[0]) { bands[0].style.left = lo + "%"; bands[0].style.width = Math.max(0, hi - lo) + "%"; }
    if (bands[1]) { bands[1].style.width = "0%"; }
  } else {
    const rampLo = viewPct(threshLo - roleExcessRefUs(role));
    const rampHi = viewPct(threshHi + roleExcessRefUs(role));
    if (bands[0]) { bands[0].style.left = rampLo + "%"; bands[0].style.width = Math.max(0, lo - rampLo) + "%"; }
    if (bands[1]) { bands[1].style.left = hi + "%"; bands[1].style.width = Math.max(0, rampHi - hi) + "%"; }
  }
  const focus = $("rangeMapFocus");
  const sense = roleSenseBounds(role);
  if (focus) {
    if (role === "interaction" && thresholdsEnabled) {
      focus.style.width = "0%";
    } else if (Number.isFinite(sense.lo) && Number.isFinite(sense.hi)) {
      const fLo = viewPct(sense.lo);
      const fHi = viewPct(sense.hi);
      focus.style.left = fLo + "%";
      focus.style.width = Math.max(0, fHi - fLo) + "%";
    } else {
      focus.style.width = "0%";
    }
  }
  if (thumb) thumb.style.left = viewPct(last) + "%";
  const thumbMod = $("rangeMapThumbMod");
  if (thumbMod) {
    thumbMod.style.left = viewPct(roleModViewUs(role)) + "%";
    thumbMod.classList.toggle("is-rest", resting);
  }
}

function syncRoleButtons() {
  let shown = 0;
  document.querySelectorAll(".role-tab").forEach((btn) => {
    const role = btn.dataset.role;
    const on = !subPanelOpen() && role === uiRole;
    const enabled = !!(routing[role] && routing[role].on);
    btn.classList.toggle("active", on);
    btn.classList.toggle("is-off", !enabled);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (enabled) shown++;
  });
  document.documentElement.style.setProperty("--pip-count", String(shown));
}

function renderRolePanel() {
  const panel = $("rolePanel");
  if (!panel) return;
  const role = uiRole;
  const r = routing[role];
  const t01 = smoothedT01[role] ?? roleLinkT01(role);
  let html = `<div class="role-panel" data-role="${role}">`;
  html += `<div class="inst-row">`;
  html += `<label class="switch" title="Activer la piste">`;
  html += `<input type="checkbox" id="roleEnabled" ${r.on ? "checked" : ""} aria-label="Activer la piste">`;
  html += `<span class="switch-ui"></span>`;
  html += `</label>`;
  html += instSelectHtml(r.inst, r.on);
  html += `</div>`;
  html += `<div class="role-settings${r.on ? "" : " is-disabled"}"${r.on ? "" : " inert"}>`;
  html += `<div class="chip-block">`;
  html += `<div class="chip-head"><h4>Liaison capteur</h4>`;
  html += `<button type="button" class="invert-toggle${roleModInvert(role) ? " is-on" : ""}" id="modInvert" aria-pressed="${roleModInvert(role) ? "true" : "false"}" title="Inverser le signal" aria-label="Inverser le signal">Inv</button>`;
  html += `<span class="sensor-readout">`;
  html += `<span class="sensor-live" id="sensorLiveVal">${formatUs(history.length ? history[history.length - 1] : NaN)}</span>`;
  html += `<span class="sensor-ratio" id="sensorRatioVal">${formatRoleRatio(role)}</span>`;
  html += `</span></div>`;
  html += rangeMapHtml(role);
  html += paramRowHtml({
    id: "modSmooth",
    label: "Lissage",
    min: 0,
    max: MOD_SMOOTH_MAX,
    step: 0.1,
    value: roleModSmooth(role),
    formatted: formatParamVal("modSmooth", roleModSmooth(role)),
    linked: false,
    showLink: false,
    extraAttrs: `data-role-mod="modSmooth"`,
    resetKind: "mod",
    resetId: "modSmooth",
    labelTitle: "Suivi lent du signal. 0 = immédiat. Plus haut = la piste ignore les à-coups.",
  });
  html += paramRowHtml({
    id: "modSense",
    label: "Sensibilité",
    min: 0,
    max: 100,
    step: 1,
    value: roleModSense(role),
    formatted: formatParamVal("modSense", roleModSense(role)),
    linked: false,
    showLink: false,
    extraAttrs: `data-role-mod="modSense"`,
    resetKind: "mod",
    resetId: "modSense",
    labelTitle: roleSenseHint(role),
  });
  html += paramRowHtml({
    id: "modMotion",
    label: "Mouvement",
    min: 0,
    max: 100,
    step: 1,
    value: roleModMotion(role),
    formatted: formatParamVal("modMotion", roleModMotion(role)),
    linked: false,
    showLink: false,
    extraAttrs: `data-role-mod="modMotion"`,
    resetKind: "mod",
    resetId: "modMotion",
    labelTitle: roleMotionHint(role),
  });
  html += paramRowHtml({
    id: "modAmount",
    label: "Étendue",
    min: 0,
    max: 100,
    step: 1,
    value: roleModAmount(role),
    formatted: formatParamVal("modAmount", roleModAmount(role)),
    linked: false,
    showLink: false,
    extraAttrs: `data-role-mod="modAmount"`,
    resetKind: "mod",
    resetId: "modAmount",
    labelTitle: "Course du paramètre lié autour de sa valeur de repos.",
  });
  html += `</div>`;
  html += `<div class="chip-block"><div class="chip-head"><h4>Instrument</h4></div>`;
  html += instParams(r.inst).map((p) => {
    const live = roleParamValue(role, p.id, t01);
    const step = (p.max - p.min) > 20 ? 1 : 0.01;
    return paramRowHtml({
      id: p.id,
      label: p.label,
      min: p.min,
      max: p.max,
      step,
      value: live,
      formatted: formatInstParam(p, live),
      linked: r.param === p.id,
      extraAttrs: `id="role-param-${p.id}" data-role-param="${p.id}"`,
      resetKind: "inst",
      resetId: p.id,
    });
  }).join("");
  html += `</div></div></div>`;
  panel.innerHTML = html;
  panel.querySelector("#roleEnabled")?.addEventListener("change", (e) => setRoleEnabled(role, e.target.checked));
  panel.querySelector("#roleInst")?.addEventListener("change", (e) => setRoleInstrument(role, e.target.value));
  panel.querySelectorAll("input[data-link-param]").forEach((box) => {
    box.addEventListener("change", () => {
      setRoleParam(role, box.checked ? box.dataset.linkParam : null);
    });
  });
  panel.querySelectorAll("input[data-role-param]").forEach((input) => {
    input.addEventListener("input", () => {
      const pSpec = paramSpec(r.inst, input.dataset.roleParam);
      if (!pSpec) return;
      const val = Number(input.value);
      setRoleParamValue(role, pSpec.id, val);
      const valEl = input.closest(".param-row")?.querySelector(".param-val");
      if (valEl) valEl.textContent = formatInstParam(pSpec, val);
      syncResetButton(input.closest(".param-row")?.querySelector(".param-reset"));
    });
  });
  panel.querySelectorAll("input[data-role-mod]").forEach((input) => {
    input.addEventListener("input", () => {
      const key = input.dataset.roleMod;
      const val = Number(input.value);
      if (!Number.isFinite(val)) return;
      if (key === "modSmooth") routing[role].modSmooth = clamp(val, 0, MOD_SMOOTH_MAX);
      if (key === "modAmount") routing[role].modAmount = clamp(val, 0, 100);
      if (key === "modSense") routing[role].modSense = clamp(val, 0, 100);
      if (key === "modMotion") routing[role].modMotion = clamp(val, 0, 100);
      const valEl = input.closest(".param-row")?.querySelector(".param-val");
      if (valEl) valEl.textContent = formatParamVal(key, routing[role][key]);
      saveRouting();
      if (key === "modAmount" || key === "modSense" || key === "modMotion") {
        const t = roleLinkT01(role);
        slowT01[role] = t;
        smoothedT01[role] = t;
        applyLinkedControl(role, t, true);
      }
      syncResetButton(input.closest(".param-row")?.querySelector(".param-reset"));
      syncSensorLinkUi();
    });
  });
  panel.querySelector("#modInvert")?.addEventListener("click", () => {
    routing[role].modInvert = !roleModInvert(role);
    saveRouting();
    applyLinkedControl(role, smoothedT01[role] ?? roleLinkT01(role), true);
    const btn = panel.querySelector("#modInvert");
    if (btn) {
      const on = roleModInvert(role);
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    syncSensorLinkUi();
  });
  panel.querySelectorAll("input[type=range][data-param]").forEach(bindParamInput);
  bindParamResets(panel);
  syncRoleButtons();
  syncSensorLinkUi();
  const nFaust = Object.keys(routing).filter((k) => routing[k].on && isFaustKind(routing[k].inst)).length;
  const hint = $("faustHint");
  if (hint) hint.hidden = nFaust < 2;
}

function maybePrefetchFaust() {
  if (!window.FaustGarden) return;
  const kinds = Object.keys(routing).map((role) => routing[role].inst).filter((id) => INST[id]);
  FaustGarden.prefetch(kinds).catch((err) => dbgError("FAUST", err));
}

loadPersistedConfig();
syncParamSlider("masterVol");
syncParamSlider("bpm");
setThresholdsEnabled(!!routing.interaction.on);
renderRolePanel();
bindParamResets(document);
wireConfigFiles();

document.querySelectorAll(".role-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!settingsOpen) return;
    uiRole = btn.dataset.role;
    if (subPanelOpen()) {
      infoOpen = false;
      filesOpen = false;
      aboutOpen = false;
      updatePanels();
    }
    renderRolePanel();
  });
});

function setThresholdsEnabled(on) {
  thresholdsEnabled = !!on;
  document.body.classList.toggle("thresholds-off", !thresholdsEnabled);
  currentZone = "";
  zoneHoldUntil = 0;
  smoothedZone = 0;
  syncFaustRoleGains();
  syncSensorLinkUi();
  requestGraphRedraw();
}

function loadGraphAnimations() {
  if (!graphAnimFromConfig) {
    try {
      const raw = localStorage.getItem(GRAPH_ANIM_KEY);
      if (raw === "0") graphAnimations = false;
      else if (raw === "1") graphAnimations = true;
      else graphAnimations = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      graphAnimations = true;
    }
  }
  const box = $("graphAnimEnabled");
  if (box) box.checked = graphAnimations;
  document.body.classList.toggle("graph-anim-off", !graphAnimations);
}

function setGraphAnimations(on) {
  graphAnimations = !!on;
  const box = $("graphAnimEnabled");
  if (box) box.checked = graphAnimations;
  document.body.classList.toggle("graph-anim-off", !graphAnimations);
  try { localStorage.setItem(GRAPH_ANIM_KEY, graphAnimations ? "1" : "0"); } catch (_) { /* quota */ }
  persistConfig();
  if (!graphAnimations) noteRipples.length = 0;
  requestGraphRedraw();
}

$("graphAnimEnabled")?.addEventListener("change", (e) => {
  setGraphAnimations(e.target.checked);
});

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function syncFullscreenButton() {
  const btn = $("fullscreenToggle");
  if (!btn) return;
  const on = !!fullscreenElement();
  btn.textContent = on ? "Quitter le plein écran" : "Plein écran";
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

async function toggleFullscreen() {
  const root = document.documentElement;
  try {
    if (fullscreenElement()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else if (root.requestFullscreen) {
      await root.requestFullscreen();
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  } catch (_) { /* refus du navigateur */ }
  syncFullscreenButton();
}

document.addEventListener("fullscreenchange", syncFullscreenButton);
document.addEventListener("webkitfullscreenchange", syncFullscreenButton);

function syncGeneralControls() {
  const dynBox = $("dynThreshEnabled");
  if (dynBox) dynBox.checked = !!G.dynamicThresholds;
  const centerBox = $("autoCenterEnabled");
  if (centerBox) centerBox.checked = !!G.autoCenter;
  const zoomBox = $("autoZoomEnabled");
  if (zoomBox) zoomBox.checked = !!G.autoZoom;
  const xfadeBox = $("zoneXfadeEnabled");
  if (xfadeBox) xfadeBox.checked = G.zoneXfade !== false;
  const dynControls = $("dynThreshControls");
  if (dynControls) dynControls.hidden = !G.dynamicThresholds;
  const centerControls = $("autoCenterControls");
  if (centerControls) centerControls.hidden = !G.autoCenter;
  const zoomControls = $("autoZoomControls");
  if (zoomControls) zoomControls.hidden = !G.autoZoom;
  document.body.classList.toggle("auto-center-on", !!G.autoCenter);
  const recenter = $("viewRecenter");
  if (recenter) {
    recenter.hidden = !!G.autoCenter;
    recenter.setAttribute("aria-hidden", G.autoCenter ? "true" : "false");
  }
  const xfadeControls = $("zoneXfadeControls");
  if (xfadeControls) xfadeControls.hidden = G.zoneXfade === false;
  document.querySelectorAll("input[data-general]").forEach((input) => {
    const key = input.dataset.general;
    if (!(key in G_SPEC)) return;
    input.value = String(G[key]);
    const valEl = input.closest(".param-row")?.querySelector(".param-val");
    if (valEl) valEl.textContent = formatGeneralVal(key, G[key]);
  });
}

function setDynamicThresholds(on) {
  G.dynamicThresholds = !!on;
  if (G.dynamicThresholds) dynCenter = (threshLo + threshHi) / 2;
  syncGeneralControls();
  persistConfig();
  requestGraphRedraw();
}

function setAutoCenter(on) {
  G.autoCenter = !!on;
  if (G.autoCenter) snapAutoFrame();
  syncGeneralControls();
  persistConfig();
  requestGraphRedraw();
}

function setAutoZoom(on) {
  G.autoZoom = !!on;
  if (G.autoZoom) {
    zoomHalf = NaN;
    snapAutoFrame();
  } else {
    zoomHalf = NaN;
  }
  syncGeneralControls();
  persistConfig();
  requestGraphRedraw();
}

function setZoneXfade(on) {
  G.zoneXfade = !!on;
  if (!G.zoneXfade) {
    smoothedZone = (!thresholdsEnabled || currentZone !== "interaction") ? 0 : 1;
    syncFaustRoleGains();
  }
  syncGeneralControls();
  persistConfig();
}

function bindGeneralControls() {
  $("dynThreshEnabled")?.addEventListener("change", (e) => {
    setDynamicThresholds(e.target.checked);
  });
  $("autoCenterEnabled")?.addEventListener("change", (e) => {
    setAutoCenter(e.target.checked);
  });
  $("autoZoomEnabled")?.addEventListener("change", (e) => {
    setAutoZoom(e.target.checked);
  });
  $("zoneXfadeEnabled")?.addEventListener("change", (e) => {
    setZoneXfade(e.target.checked);
  });
  document.querySelectorAll("input[data-general]").forEach((input) => {
    if (input.dataset.bound === "1") return;
    const key = input.dataset.general;
    if (!(key in G_SPEC)) return;
    const spec = G_SPEC[key];
    const valEl = input.closest(".param-row")?.querySelector(".param-val");
    const sync = () => {
      const raw = Number(input.value);
      if (!Number.isFinite(raw)) return;
      G[key] = clamp(raw, spec.min, spec.max);
      if (valEl) valEl.textContent = formatGeneralVal(key, G[key]);
      persistConfig();
      requestVisualUpdate();
    };
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
    input.dataset.bound = "1";
  });
  syncGeneralControls();
}

loadGraphAnimations();
bindGeneralControls();
persistConfig();
loadPicoSettings();

$("debugToggle")?.addEventListener("change", (e) => {
  toggleDebug(e.target.checked);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (settingsOpen || infoOpen || filesOpen || aboutOpen)) closeSettings();
});

function applyParam(key, raw) {
  switch (key) {
    case "masterVol":
    case "ambientVol":
    case "vegetalVol":
    case "interVol":
      syncFaustRoleGains();
      break;
    case "bpm":
      pushAllTempos();
      break;
  }
}

function applyAllParams() {
  for (const key of Object.keys(P)) applyParam(key, P[key]);
}

// ─── Liaison avec le Pico ───
// La page est servie par le point d'accès du Pico : le flux de mesures est
// donc toujours en même origine, via Server-Sent Events.
const STREAM_URL = "/api/stream";
const STATUS_URL = "/api/status";
const STREAM_STALE_MS = 6000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;

let stream = null;
let streamLive = false;
let streamWanted = true;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let watchdogTimer = null;
let lastStreamMsg = 0;
let lastDroppedCount = 0;
let lastSeq = 0;

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = "connect-status " + cls;
}

function setConnectButton(connected) {
  const btn = $("btn");
  btn.textContent = connected ? "Arrêter" : "Reconnecter";
  btn.classList.toggle("disconnect", connected);
}

function toggle() {
  if (streamWanted) disconnect();
  else connect();
}

async function refreshStatusInfo() {
  try {
    const response = await fetch(STATUS_URL, { cache: "no-store" });
    const status = await response.json();
    $("connectInfo").textContent =
      `${status.ssid} · http://${status.ip} · GP${status.sensor_pin} · ${status.period_us} µs`;
    dbgLog("INFO", "PICO", "État", status);
  } catch (err) {
    $("connectInfo").textContent = "Hors ligne — Wi-Fi Plante-Musicale · http://192.168.4.1";
    dbgError("PICO", err);
  }
}

function closeStream() {
  if (stream) {
    stream.onopen = stream.onmessage = stream.onerror = null;
    stream.close();
    stream = null;
  }
  streamLive = false;
}

function scheduleReconnect() {
  if (!streamWanted || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (streamWanted) connect();
  }, delay);
  dbgLog("INFO", "SSE", `Nouvelle tentative dans ${delay} ms`);
}

function connect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeStream();
  streamWanted = true;
  setStatus("Connexion…", "off");
  setConnectButton(true);

  const url = lastSeq > 0 ? STREAM_URL + "?after=" + lastSeq : STREAM_URL;
  stream = new EventSource(url);

  stream.onopen = () => {
    streamLive = true;
    reconnectDelay = RECONNECT_MIN_MS;
    lastStreamMsg = performance.now();
    dbgBatchCount = 0;
    dbgGlitchBatchCount = 0;
    setStatus("Connecté", "on");
    dbgLog("INFO", "SSE", "Flux ouvert", url);
    dbgStartHeartbeat();
    startWatchdog();
    refreshStatusInfo();
  };

  stream.onmessage = (evt) => {
    lastStreamMsg = performance.now();
    if (!streamLive) {
      streamLive = true;
      setStatus("Connecté", "on");
    }
    try {
      const data = JSON.parse(evt.data);
      if (typeof data.seq === "number") lastSeq = data.seq;
      if (typeof data.dropped === "number") lastDroppedCount = data.dropped;
      if (Array.isArray(data.intervals_us)) {
        if (data.intervals_us.length) handlePulses(data.intervals_us);
      } else {
        dbgLog("WARN", "SSE", "Message sans intervals_us", Object.keys(data));
      }
    } catch (err) {
      dbgError("SSE", err);
    }
  };

  stream.onerror = () => {
    streamLive = false;
    setStatus("Reconnexion…", "error");
    // readyState CONNECTING : le navigateur réessaie seul (en-tête retry).
    // readyState CLOSED : flux refusé (503, place déjà prise) → à nous de jouer.
    if (!stream || stream.readyState === EventSource.CLOSED) {
      closeStream();
      scheduleReconnect();
    }
  };
}

function disconnect() {
  streamWanted = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopWatchdog();
  closeStream();
  dbgStopHeartbeat();
  dbgLog("INFO", "SSE", "Flux arrêté");
  setStatus("Déconnecté", "off");
  setConnectButton(false);
}

// Un point d'accès Wi-Fi qui décroche laisse parfois un EventSource « ouvert »
// mais muet : on le recrée si le Pico ne parle plus.
function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    if (!streamWanted || !stream) return;
    if (performance.now() - lastStreamMsg < STREAM_STALE_MS) return;
    dbgLog("WARN", "SSE", "Flux muet — réouverture");
    closeStream();
    scheduleReconnect();
  }, 2000);
}

function stopWatchdog() {
  if (watchdogTimer != null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ─── Data handling ───
// Fenêtre de plausibilité large : le Pico mesure la période complète du capteur
// (~20 000 µs à 50 Hz). Après un recentrage, on se cale sur les seuils.
const ABS_MIN_INTERVAL_US = 100;
const ABS_MAX_INTERVAL_US = 250000;

function updateProvisionalView(data) {
  let lo = data[0];
  let hi = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i] < lo) lo = data[i];
    if (data[i] > hi) hi = data[i];
  }
  fitVerticalView(lo, hi);
}

function intervalBounds() {
  if (viewFitted && Number.isFinite(threshLo) && Number.isFinite(threshHi) && threshHi > threshLo) {
    const margin = Math.max((threshHi - threshLo) * 12, 3500);
    return [threshLo - margin, threshHi + margin];
  }
  return [ABS_MIN_INTERVAL_US, ABS_MAX_INTERVAL_US];
}

function sanitizeIntervals(raw) {
  const [softLo, softHi] = intervalBounds();
  const clean = [];
  const rejected = [];
  for (let i = 0; i < raw.length; i++) {
    const v = Number(raw[i]);
    if (!Number.isFinite(v)) {
      rejected.push(raw[i]);
      continue;
    }
    const rounded = Math.round(v);
    if (rounded < ABS_MIN_INTERVAL_US || rounded > ABS_MAX_INTERVAL_US) {
      rejected.push(v);
      continue;
    }
    if (rounded < softLo || rounded > softHi) {
      rejected.push(v);
      continue;
    }
    clean.push(rounded);
  }
  if (rejected.length > 0 && performance.now() - dbgLastAnomalyLog > 350) {
    dbgLastAnomalyLog = performance.now();
    dbgLog("WARN", "OUTLIER", `${rejected.length} glitch(s) ignoré(s)`, {
      values: rejected.slice(0, 4),
      bounds: [softLo, softHi],
    });
  }
  return clean;
}

function batchMedian(intervals) {
  if (intervals.length === 1) return intervals[0];
  const sorted = intervals.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function handlePulses(rawIntervals) {
  const rawN = rawIntervals.length;
  const intervals = sanitizeIntervals(rawIntervals);
  const n = intervals.length;
  if (n === 0) {
    if (rawN > 0) dbgGlitchBatchCount++;
    return;
  }
  dbgBatchCount++;
  totalPulses += n;
  lastPulseAt = performance.now();
  for (let i = 0; i < n; i++) {
    history.push(intervals[i]);
    noteMarkers.push(false);
  }
  pushMeanSamples(intervals);
  if (history.length > MAX_HISTORY) {
    const excess = history.length - MAX_HISTORY;
    history.splice(0, excess);
    noteMarkers.splice(0, excess);
    for (let i = 0; i < noteRipples.length; i++) noteRipples[i].idx -= excess;
    lastPeakIdx -= excess;
    if (lastPeakIdx < -1) lastPeakIdx = -1;
  }

  let batchMin = intervals[0];
  let batchMax = intervals[0];
  for (let i = 1; i < n; i++) {
    if (intervals[i] < batchMin) batchMin = intervals[i];
    if (intervals[i] > batchMax) batchMax = intervals[i];
  }
  lastBatchAvg = Math.round(batchMedian(intervals));
  dbgNoteSignalAnomaly(rawN, intervals, batchMin, batchMax);

  lastSecondCount += n;
  const now = performance.now();
  if (now - lastSecondTime >= 1000) {
    $("rate").textContent = lastSecondCount;
    lastSecondCount = 0;
    lastSecondTime = now;
  }

  if (!isViewReady() && history.length >= 5) updateProvisionalView(history);
  if (recording) recordSamples(intervals);
  ingestAmbientCv(intervals);
  if (audioEnabled) {
    try {
      if (sonify(intervals)) {
        needGraphDraw = true;
        drawGraph();
        needGraphDraw = false;
      }
    } catch (err) { dbgError("SONIFY", err); }
  }
  requestVisualUpdate();
}

const MAX_DPR = 2;

function ensureCanvasBackingStore(canvas, ctx) {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const cssW = canvas.clientWidth | 0;
  const cssH = canvas.clientHeight | 0;
  if (cssW < 1 || cssH < 1) return false;
  if (
    canvas._bkW === cssW &&
    canvas._bkH === cssH &&
    canvas._bkDpr === dpr
  ) {
    return true;
  }
  canvas._bkW = cssW;
  canvas._bkH = cssH;
  canvas._bkDpr = dpr;
  canvas.width = Math.max(1, (cssW * dpr) | 0);
  canvas.height = Math.max(1, (cssH * dpr) | 0);
  return true;
}

// ─── Ambient Garden (patches Faust précompilés) ───

function resumeFaustContexts() {
  if (!window.FaustGarden) return;
  const slots = FaustGarden.slots || {};
  for (const name of Object.keys(slots)) {
    const patch = slots[name];
    if (patch && patch.ctx && patch.ctx.state === "suspended") {
      patch.ctx.resume().catch(() => {});
    }
  }
}

function roleAudioMissing() {
  if (!window.FaustGarden) return false;
  for (const role of ROLE_IDS) {
    const r = routing[role];
    if (r && r.on && INST[r.inst] && !FaustGarden.get(role)) return true;
  }
  return false;
}

function ensureAudioRunning() {
  if (audioEnabled) {
    resumeFaustContexts();
    startModLoop();
    return;
  }
  audioEnabled = true;
  startModLoop();
}

function unlockAudio() {
  const first = !audioEnabled;
  ensureAudioRunning();
  if (first || roleAudioMissing()) syncAllRoleAudio();
}

function roleDriveMode(role) {
  return (role === "interaction" && thresholdsEnabled) ? "unipolar" : "bipolar";
}

function paramCenter(spec, stored) {
  if (Number.isFinite(stored)) return clamp(stored, spec.min, spec.max);
  return Number.isFinite(spec.def) ? spec.def : (spec.min + spec.max) * 0.5;
}

function mapDriven(spec, center, t01, mode, amountSlider) {
  const amount = clamp((amountSlider ?? DEFAULT_MOD_AMOUNT) / 100, 0, 1);
  const t = clamp(t01, 0, 1);
  const c = paramCenter(spec, center);
  if (spec.freq) {
    const lo = Math.max(spec.min, 20);
    const hi = Math.max(spec.max, lo + 1);
    if (mode === "unipolar") {
      const oct = t * amount * Math.log2(hi / Math.max(c, lo));
      return clamp(c * Math.pow(2, oct), spec.min, spec.max);
    }
    const oct = (t * 2 - 1) * amount * Math.log2(hi / lo) * 0.5;
    return clamp(c * Math.pow(2, oct), spec.min, spec.max);
  }
  if (mode === "unipolar") {
    return clamp(c + t * (spec.max - c) * amount, spec.min, spec.max);
  }
  const half = (spec.max - spec.min) * amount * 0.5;
  return clamp(c + (t * 2 - 1) * half, spec.min, spec.max);
}

function tickZoneCrossfade(dt) {
  const target = (!thresholdsEnabled || currentZone !== "interaction") ? 0 : 1;
  if (G.zoneXfade === false) {
    smoothedZone = target;
    return;
  }
  const dur = Math.max((G.zoneXfadeMs || G_SPEC.zoneXfadeMs.def) / 1000, 0.04);
  const step = Math.max(dt, 0) / dur;
  if (Math.abs(target - smoothedZone) <= step) smoothedZone = target;
  else if (smoothedZone < target) smoothedZone += step;
  else smoothedZone -= step;
}

// Décroissance exponentielle : 1 au début, 0 à la fin.
// La baisse de niveau est répartie sur toute la durée, avec une queue en fin de fondu.
function expDecayGain(t) {
  const k = 2.4;
  const d = clamp(t, 0, 1);
  if (d <= 0) return 1;
  if (d >= 1) return 0;
  const end = Math.exp(-k);
  return (Math.exp(-k * d) - end) / (1 - end);
}

function tickSignalFade(dt) {
  const age = lastPulseAt > 0 ? (performance.now() - lastPulseAt) / 1000 : Infinity;
  const hold = 0.7;
  const dur = Math.max((G.zoneXfadeMs || 4000) / 1000, 4);
  if (age > hold) {
    const t = Number.isFinite(age) ? clamp((age - hold) / dur, 0, 1) : 1;
    signalGain = Math.min(signalGain, expDecayGain(t));
    return;
  }
  const step = Math.max(dt, 0) / 0.22;
  signalGain = Math.min(1, signalGain + step);
}

function roleZoneGate(role) {
  if (!thresholdsEnabled) return 1;
  if (role !== "interaction") return 1;
  const x = clamp(smoothedZone, 0, 1);
  return expDecayGain(1 - x);
}

function roleFaustGain(role) {
  if (!audioEnabled || !routing[role].on || !INST[routing[role].inst]) return 0.0001;
  const master = P.masterVol / 100;
  const vol = liveRoleVolume(role) / 100;
  const level = INST[routing[role].inst].level || 0.38;
  const gate = roleZoneGate(role) * signalGain;
  return Math.max(master * vol * level * gate, 0.0001);
}

function liveRoleVolume(role) {
  return P[ROLE_VOL[role]];
}

const TEMPO_INST = {
  "wind-chimes": true,
  "wind-bells": true,
  "rain-stick": true,
};

function tempoFactor() {
  return Math.max(1, P.bpm) / 60;
}

function pushRoleTempo(role) {
  if (!window.FaustGarden || !FaustGarden.get(role)) return;
  if (!TEMPO_INST[routing[role].inst]) return;
  FaustGarden.setParam(role, "tempo", tempoFactor());
}

function pushAllTempos() {
  pushRoleTempo("ambiance");
  pushRoleTempo("vegetal");
  pushRoleTempo("interaction");
}

function roleParamValue(role, paramId, t01) {
  const spec = paramSpec(routing[role].inst, paramId);
  if (!spec) return 0;
  const r = routing[role];
  const stored = r.vals && Number.isFinite(r.vals[paramId]) ? r.vals[paramId] : null;
  if (r.param === paramId) {
    const center = stored != null ? stored : spec.def;
    return mapDriven(spec, center, roleShapedT01(role, t01), roleDriveMode(role), roleModAmount(role));
  }
  if (stored != null) return stored;
  return spec.def;
}

function faustParamValue(role, paramId, t01) {
  const spec = paramSpec(routing[role].inst, paramId);
  if (!spec) return 0;
  return roleParamValue(role, paramId, t01);
}

function pushFaustParam(role, paramId, t01) {
  if (!window.FaustGarden || !FaustGarden.get(role)) return;
  const spec = paramSpec(routing[role].inst, paramId);
  if (!spec) return;
  FaustGarden.setParam(role, spec.id, faustParamValue(role, spec.id, t01));
}

function applyFaustLinked(role, t01, all) {
  if (!window.FaustGarden || !FaustGarden.get(role)) return;
  const r = routing[role];
  if (!INST[r.inst]) return;
  if (all) {
    for (const spec of instParams(r.inst)) {
      FaustGarden.setParam(role, spec.id, faustParamValue(role, spec.id, t01));
    }
    pushRoleTempo(role);
    return;
  }
  if (r.param) pushFaustParam(role, r.param, t01);
}

function roleSenseK(role) {
  const s = clamp(roleModSense(role), 0, 100) / 100;
  return Math.max(0.14, 1 - s * 0.86);
}

function threshMid() {
  return (threshLo + threshHi) / 2;
}

function mapBipolarWindow(v, lo, hi, k, fallback) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(v)) return fallback;
  const mid = (lo + hi) / 2;
  const x = (v - mid) / ((span / 2) * Math.max(k, 0.04));
  return clamp(0.5 + 0.5 * x, 0, 1);
}

function roleExcessRefUs(role) {
  return Math.max(threshSpanUs() / 2, 1) * roleSenseK(role) * 1.8;
}

function roleSenseBounds(role) {
  const k = roleSenseK(role);
  if (role === "ambiance" || !thresholdsEnabled) {
    if (!isViewReady()) return { lo: NaN, hi: NaN };
    const mid = (globalMin + globalMax) / 2;
    const half = (viewRange() / 2) * k;
    return { lo: mid - half, hi: mid + half };
  }
  if (role === "vegetal") {
    const mid = threshMid();
    const half = (threshSpanUs() / 2) * k;
    return { lo: mid - half, hi: mid + half };
  }
  const ref = roleExcessRefUs(role);
  return { lo: threshLo - ref, hi: threshHi + ref, ref };
}

function roleRawT01(role) {
  const last = history.length ? history[history.length - 1] : ambMean;
  if (role === "ambiance" || !thresholdsEnabled) {
    if (!isViewReady()) return 0.5;
    return mapBipolarWindow(last, globalMin, globalMax, roleSenseK(role), 0.5);
  }
  if (role === "vegetal") {
    if (last < threshLo || last > threshHi) return 0.5;
    return mapBipolarWindow(last, threshLo, threshHi, roleSenseK(role), 0.5);
  }
  const ref = Math.max(roleExcessRefUs(role), 1);
  let excess = 0;
  if (last > threshHi) excess = last - threshHi;
  else if (last < threshLo) excess = threshLo - last;
  else return 0;
  return clamp(excess / ref, 0, 1);
}

function roleActivityT01(role) {
  const cv = currentAmbientCv();
  const last = cv.last;
  const energy = clamp(Math.max(cv.liveN, cv.energyN) * 1.25, 0, 1);
  const wig = clamp(Math.abs(cv.microN), 0, 1);
  const alive = Math.max(energy, wig);
  if (role === "ambiance" || !thresholdsEnabled) {
    return clamp(energy * 0.62 + wig * 0.38, 0, 1);
  }
  if (role === "vegetal") {
    if (last < threshLo || last > threshHi) return 0.5;
    const dir = Math.tanh((last - threshMid()) / Math.max(threshSpanUs() * 0.08, 16));
    return clamp(0.5 + 0.5 * dir * (0.22 + 0.78 * alive), 0, 1);
  }
  if (last >= threshLo && last <= threshHi) return 0;
  return clamp(0.2 + 0.8 * alive, 0, 1);
}

function roleLinkT01(role) {
  const pos = roleRawT01(role);
  const act = roleActivityT01(role);
  const m = clamp(roleModMotion(role), 0, 100) / 100;
  return clamp(pos * (1 - m) + act * m, 0, 1);
}

function roleFilteredT01(role) {
  return clamp(smoothedT01[role] ?? roleLinkT01(role), 0, 1);
}

function roleControlT01(role) {
  return roleShapedT01(role, roleFilteredT01(role));
}

function roleThumbT01(role) {
  let t = roleFilteredT01(role);
  if (roleModInvert(role)) t = 1 - t;
  return t;
}

function roleSignalInZone(role) {
  if (role === "ambiance" || !thresholdsEnabled) return true;
  if (!history.length) return true;
  const last = history[history.length - 1];
  if (role === "vegetal") return last >= threshLo && last <= threshHi;
  return last < threshLo || last > threshHi;
}

function formatRoleRatio(role) {
  const pct = Math.round(roleControlT01(role) * 100);
  if (role === "vegetal" && thresholdsEnabled && !roleSignalInZone(role)) {
    return "repos " + pct + " %";
  }
  return pct + " %";
}

function roleModViewUs(role) {
  const t01 = roleThumbT01(role);
  if (role === "ambiance" || !thresholdsEnabled) {
    const b = roleSenseBounds(role);
    if (!Number.isFinite(b.lo) || !Number.isFinite(b.hi)) return NaN;
    return b.lo + t01 * (b.hi - b.lo);
  }
  if (role === "vegetal") {
    const b = roleSenseBounds(role);
    return b.lo + t01 * Math.max(b.hi - b.lo, 1);
  }
  const last = history.length ? history[history.length - 1] : ambMean;
  const ref = roleExcessRefUs(role);
  if (last >= threshMid()) return threshHi + t01 * ref;
  return threshLo - t01 * ref;
}

function applyLinkedControl(role, t01, all) {
  const r = routing[role];
  if (!r) return;
  const t = clamp(t01, 0, 1);
  applyFaustLinked(role, t, all);
  if (window.FaustGarden) FaustGarden.setGain(role, roleFaustGain(role));
}

function maybeSyncLinkedUi() {
  if (!audioEnabled) {
    const now = performance.now();
    const dt = lastModTick ? Math.min(0.08, (now - lastModTick) / 1000) : 0.016;
    lastModTick = now;
    updateRoleFilters(dt);
  }
  if (!settingsOpen || subPanelOpen()) return;
  const now = performance.now();
  if (now - lastLinkedUiSync < 80) return;
  lastLinkedUiSync = now;
  syncLinkedUi(uiRole);
  syncSensorLinkUi();
}

function syncLinkedUi(role) {
  const panel = $("rolePanel");
  if (!settingsOpen || subPanelOpen() || uiRole !== role || !panel) return;
  const r = routing[role];
  const t01 = smoothedT01[role] ?? roleLinkT01(role);
  if (!r.param) return;
  const spec = paramSpec(r.inst, r.param);
  if (!spec) return;
  const input = panel.querySelector("#role-param-" + spec.id);
  if (!input) return;
  const live = roleParamValue(role, spec.id, t01);
  input.value = String(live);
  const valEl = input.closest(".param-row")?.querySelector(".param-val");
  if (valEl) valEl.textContent = formatInstParam(spec, live);
}

function syncFaustRoleGains() {
  if (!window.FaustGarden) return;
  for (const role of Object.keys(routing)) {
    if (FaustGarden.get(role)) FaustGarden.setGain(role, roleFaustGain(role));
  }
}

function startModLoop() {
  startRolePips();
}

function stopModLoop() {
  lastModTick = 0;
}

function followTauSec(role, target, current, tau) {
  if (tau <= 0) return 0;
  if (role === "interaction") {
    return target > current + 0.002 ? Math.max(tau * 0.18, 0.02) : tau;
  }
  const tDev = Math.abs(target - 0.5);
  const cDev = Math.abs(current - 0.5);
  if (tDev > cDev + 0.002) return Math.max(tau * 0.32, 0.03);
  return tau;
}

function updateRoleFilters(dt) {
  for (const role of ["ambiance", "vegetal", "interaction"]) {
    const tau = smoothTauSec(roleModSmooth(role));
    const target = roleLinkT01(role);
    if (tau <= 0) {
      slowT01[role] = target;
    } else {
      const follow = followTauSec(role, target, slowT01[role], tau);
      const coeff = 1 - Math.exp(-dt / Math.max(follow, 0.001));
      slowT01[role] += (target - slowT01[role]) * coeff;
    }
    smoothedT01[role] = clamp(slowT01[role], 0, 1);
  }
}

function tickModulation() {
  const now = performance.now();
  const dt = lastModTick ? Math.min(0.08, (now - lastModTick) / 1000) : 0.016;
  lastModTick = now;
  tickZoneCrossfade(dt);
  tickSignalFade(dt);
  updateRoleFilters(dt);
  for (const role of ["ambiance", "vegetal", "interaction"]) {
    if (routing[role].on) applyLinkedControl(role, smoothedT01[role]);
  }
  detectFaustAttacks();
  maybeSyncLinkedUi();
  recoverFaustIfNeeded();
}

const attackEnv = {
  vegetal: { env: 0, peak: 0, lastMark: 0, primed: false },
  interaction: { env: 0, peak: 0, lastMark: 0, primed: false },
};

function detectFaustAttacks() {
  if (!window.FaustGarden || typeof FaustGarden.peakLevel !== "function") return;
  if (!history.length) return;
  const now = performance.now();
  let hit = false;
  for (const role of ["vegetal", "interaction"]) {
    if (!routing[role] || !routing[role].on) continue;
    if (!FaustGarden.get(role)) continue;
    if (roleFaustGain(role) < 0.008) {
      attackEnv[role].primed = false;
      continue;
    }
    const peak = FaustGarden.peakLevel(role);
    if (!Number.isFinite(peak)) continue;
    const st = attackEnv[role];
    if (!st.primed) {
      st.env = peak;
      st.peak = peak;
      st.primed = true;
      st.lastMark = now;
      continue;
    }
    const rise = peak - st.peak;
    st.env += (peak - st.env) * (peak < st.env ? 0.1 : 0.03);
    st.peak = peak;
    const floor = Math.max(st.env, 0.0006);
    if (
      peak > 0.0016
      && rise > 0.0012
      && peak > floor * 1.85
      && now - st.lastMark > 70
    ) {
      markNoteIndex(history.length - 1);
      st.lastMark = now;
      hit = true;
    }
  }
  if (hit) {
    needGraphDraw = true;
    bumpVisualFrame();
  }
}

function recoverFaustIfNeeded() {
  if (!window.FaustGarden || audioRecovering) return;
  const report = FaustGarden.healthCheck();
  if (!report || !report.bad.length) return;
  const now = performance.now();
  if (now - lastAudioRecover < 3500) return;
  lastAudioRecover = now;
  dbgLog("WARN", "FAUST", "Patch instable, relance", report.bad);
  audioRecovering = true;
  const work = (async () => {
    if (report.reset) {
      await FaustGarden.stopAll({ closeContext: false });
      await syncAllRoleAudio();
      return;
    }
    for (const b of report.bad) {
      await FaustGarden.stop(b.slot);
      await syncRoleAudio(b.slot);
    }
  })();
  work.catch((err) => dbgError("FAUST", err)).finally(() => { audioRecovering = false; });
}

function unusedInstrument(exceptRole) {
  const keep = exceptRole && routing[exceptRole] ? routing[exceptRole].inst : null;
  for (const id of Object.keys(INST)) {
    if (id === keep) continue;
    const used = roleUsesInst(id);
    if (!used || used === exceptRole) return id;
  }
  return Object.keys(INST)[0];
}

function setRoleEnabled(role, on) {
  routing[role].on = !!on;
  saveRouting();
  renderRolePanel();
  if (role === "interaction") setThresholdsEnabled(!!on);
  if (on) ensureAudioRunning();
  if (audioEnabled) syncRoleAudio(role);
  if (role === "ambiance") requestGraphRedraw();
}

function setRoleInstrument(role, inst) {
  if (!INST[inst]) return;
  stashRoleInstrument(role);
  const other = roleUsesInst(inst);
  if (other && other !== role) {
    stashRoleInstrument(other);
    applyInstrumentMemory(other, unusedInstrument(other));
    if (audioEnabled) syncRoleAudio(other);
  }
  applyInstrumentMemory(role, inst);
  const ids = instParams(inst).map((p) => p.id);
  if (ids.indexOf(routing[role].param) === -1) routing[role].param = INST[inst].defaultParam;
  saveRouting();
  renderRolePanel();
  if (audioEnabled && routing[role].on) syncRoleAudio(role);
}

function setRoleParam(role, paramId) {
  if (paramId && !isRoleLinkParam(role, paramId)) return;
  if (paramId) {
    routing[role].vals = routing[role].vals || {};
    if (!Number.isFinite(routing[role].vals[paramId])) {
      routing[role].vals[paramId] = roleParamValue(role, paramId, 0.5);
    }
  }
  routing[role].param = paramId || null;
  saveRouting();
  renderRolePanel();
  applyLinkedControl(role, smoothedT01[role] ?? roleLinkT01(role), true);
}

function setRoleParamValue(role, paramId, value) {
  const spec = paramSpec(routing[role].inst, paramId);
  if (!spec) return;
  routing[role].vals = routing[role].vals || {};
  routing[role].vals[paramId] = clamp(value, spec.min, spec.max);
  saveRouting();
  if (window.FaustGarden) {
    FaustGarden.setParam(role, paramId, routing[role].vals[paramId]);
  }
}

async function syncRoleAudio(role) {
  const r = routing[role];
  if (!audioEnabled || !r.on || !INST[r.inst]) {
    if (window.FaustGarden) FaustGarden.stop(role);
    return;
  }
  try {
    await FaustGarden.start(role, r.inst);
    if (!routing[role].on || routing[role].inst !== r.inst) {
      await FaustGarden.stop(role);
      return;
    }
    applyFaustLinked(role, smoothedT01[role] ?? roleLinkT01(role), true);
    FaustGarden.setGain(role, roleFaustGain(role));
    dbgLog("INFO", "FAUST", "Slot " + role, r.inst);
  } catch (err) {
    dbgError("FAUST", err);
  }
}

function syncAllRoleAudio() {
  return Promise.all([
    syncRoleAudio("ambiance"),
    syncRoleAudio("vegetal"),
    syncRoleAudio("interaction"),
  ]);
}

function ingestAmbientCv(intervals) {
  for (let i = 0; i < intervals.length; i++) {
    const v = intervals[i];
    const diff = v - ambMean;
    ambMean += diff * 0.045;
    const abs = Math.abs(diff);
    ambVar += (abs - ambVar) * 0.08;
    ambVarFast += (abs - ambVarFast) * 0.28;
  }
}

function currentAmbientCv() {
  const last = history.length ? history[history.length - 1] : ambMean;
  const micro = last - ambMean;
  const span = Math.max(threshSpanUs(), 80);
  const scale = Math.max(span * 0.22, 60);
  const liveScale = Math.max(span * 0.07, 22);
  return {
    last,
    microN: Math.tanh(micro / Math.max(span * 0.1, 28)),
    energyN: ambVar / (ambVar + scale),
    liveN: ambVarFast / (ambVarFast + liveScale),
    shimmer: Math.tanh(Math.abs(micro) / Math.max(span * 0.06, 18)),
    plantHz: 1e6 / Math.max(last, 1),
  };
}

let lastNoteTime = 0;
let wasInInteraction = false;
const PEAK_RADIUS = 2;
const PEAK_MAD_WIN = 48;

function threshSpanUs() {
  return threshHi - threshLo || 1;
}

function bpmMinGapSec() {
  return 60 / Math.max(1, P.bpm);
}

function bpmMaxGapSec() {
  return 60 / Math.max(1, P.bpm * 0.5);
}

function rateGapSec(activity01) {
  const fastest = bpmMinGapSec();
  const slowest = bpmMaxGapSec();
  return slowest + (fastest - slowest) * clamp(activity01, 0, 1);
}

function activityNorm(delta, spread) {
  const scale = Math.max(threshSpanUs() * 0.12, 30);
  return clamp(Math.max(delta, spread) / scale, 0, 1);
}

function markNotePlayed(now) {
  lastNoteTime = now;
}

function batchSpread(intervals) {
  if (intervals.length < 2) return 0;
  let lo = intervals[0];
  let hi = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i] < lo) lo = intervals[i];
    if (intervals[i] > hi) hi = intervals[i];
  }
  return hi - lo;
}

function getBatchTrigger(intervals) {
  const center = (threshHi + threshLo) / 2;
  let value = intervals[0];
  let batchIdx = 0;
  let dist = Math.abs(value - center);
  for (let i = 1; i < intervals.length; i++) {
    const d = Math.abs(intervals[i] - center);
    if (d > dist) {
      value = intervals[i];
      dist = d;
      batchIdx = i;
    }
  }
  return { value, batchIdx };
}

function spawnNoteRipple(idx) {
  if (!graphAnimations) return;
  noteRipples.push({ idx, born: performance.now() });
  needGraphDraw = true;
  bumpVisualFrame();
}

function markNoteIndex(idx) {
  if (idx < 0 || idx >= noteMarkers.length) return;
  noteMarkers[idx] = true;
  spawnNoteRipple(idx);
}

function playMappedNote(role, spec) {
  const r = routing[role];
  if (!r.on) return false;
  if (!INST[r.inst]) return false;
  if (r.inst === "resonant-drone" || r.inst === "vibraphones") {
    const t = clamp(smoothedT01[role] ?? spec.t01, 0, 0.82);
    FaustGarden.setParam(role, "impact", t);
  }
  return true;
}

function roleHasImpact(role) {
  return !!(routing[role] && routing[role].on && paramSpec(routing[role].inst, "impact"));
}

function playVegetalNote(value, isPeak, now) {
  const peakNorm = clamp((value - threshLo) / threshSpanUs(), 0, 1);
  playMappedNote("vegetal", { t01: peakNorm, time: now });
}

function inVegetalBand(v) {
  return !thresholdsEnabled || (v >= threshLo && v <= threshHi);
}

function localNoiseFloor() {
  const end = history.length;
  const start = Math.max(0, end - PEAK_MAD_WIN);
  const n = end - start;
  if (n < 5) return { median: history[end - 1] || 0, jitter: 0 };
  const slice = history.slice(start, end);
  const sorted = slice.slice().sort((a, b) => a - b);
  const median = sorted[n >> 1];
  const diffs = [];
  for (let i = 1; i < n; i++) diffs.push(Math.abs(slice[i] - slice[i - 1]));
  diffs.sort((a, b) => a - b);
  return { median, jitter: diffs[diffs.length >> 1] };
}

function extremumKind(k) {
  if (k < PEAK_RADIUS || k + PEAK_RADIUS >= history.length) return null;
  const b = history[k];
  let peak = true;
  let trough = true;
  let sawLower = false;
  let sawHigher = false;
  for (let i = k - PEAK_RADIUS; i <= k + PEAK_RADIUS; i++) {
    if (i === k) continue;
    const v = history[i];
    if (v >= b) peak = false;
    if (v <= b) trough = false;
    if (v < b) sawLower = true;
    if (v > b) sawHigher = true;
    if (!peak && !trough) return null;
  }
  if (peak && sawLower) return "peak";
  if (trough && sawHigher) return "trough";
  return null;
}

function extremumProminence(k, isPeak, median) {
  const b = history[k];
  return isPeak ? b - median : median - b;
}

function interpolatedExtremumValue(k) {
  const a = history[k - 1];
  const b = history[k];
  const c = history[k + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return b;
  const delta = 0.5 * (a - c) / denom;
  if (delta < -0.5 || delta > 0.5) return b;
  const y = b - 0.25 * (a - c) * delta;
  const lo = Math.min(a, b, c);
  const hi = Math.max(a, b, c);
  return clamp(y, lo, hi);
}

function findBestVegetalExtremum(scanStart, scanEnd, minProm, median) {
  let best = null;
  for (let k = scanStart; k <= scanEnd; k++) {
    if (k <= lastPeakIdx) continue;
    const kind = extremumKind(k);
    if (!kind) continue;
    const raw = history[k];
    if (!inVegetalBand(raw)) continue;
    const isPeak = kind === "peak";
    const prom = extremumProminence(k, isPeak, median);
    if (prom < minProm) continue;
    if (!best || prom > best.prom) {
      best = { k, isPeak, value: interpolatedExtremumValue(k), prom };
    }
  }
  return best;
}

function findFarthestInBand(scanStart, scanEnd, median) {
  let best = null;
  let bestDist = -1;
  for (let k = scanStart; k <= scanEnd; k++) {
    if (k <= lastPeakIdx) continue;
    const raw = history[k];
    if (!inVegetalBand(raw)) continue;
    const dist = Math.abs(raw - median);
    if (dist > bestDist) {
      bestDist = dist;
      best = { k, isPeak: raw >= median, value: raw, prom: dist };
    }
  }
  return best;
}

function playFoundExtremum(found, now) {
  playVegetalNote(found.value, found.isPeak, now);
  lastPeakIdx = found.k;
  markNotePlayed(now);
}

function sonifyVegetalZone(intervals, avg, delta, now, batchLen) {
  wasInInteraction = false;
  const threshSpan = threshSpanUs();
  const spread = batchSpread(intervals);
  const activity = activityNorm(delta, spread);
  const elapsed = now - lastNoteTime;
  const mustPlay = elapsed >= bpmMaxGapSec();
  const mayPlay = elapsed >= rateGapSec(activity);
  if (!mustPlay && !mayPlay) return false;

  const len = history.length;
  const scanEnd = len - 1 - PEAK_RADIUS;
  const scanStart = Math.max(PEAK_RADIUS, lastPeakIdx + 1, len - batchLen - PEAK_RADIUS);
  if (scanEnd < scanStart) return false;

  const { median, jitter } = localNoiseFloor();
  const minProm = Math.max(18, jitter * 2.8, threshSpan * 0.02);
  const found = findBestVegetalExtremum(scanStart, scanEnd, minProm, median);
  if (found) {
    playFoundExtremum(found, now);
    return true;
  }

  if (!mustPlay) return false;

  const fallback = findBestVegetalExtremum(scanStart, scanEnd, minProm * 0.45, median)
    || findFarthestInBand(scanStart, scanEnd, median);
  if (!fallback) return false;
  playFoundExtremum(fallback, now);
  return true;
}

function consecutiveDelta(val) {
  const d = Math.abs(val - prevInterval);
  prevInterval = val;
  return d;
}

function sonify(intervals) {
  if (!audioEnabled) return false;
  const now = performance.now() / 1000;
  const batchLen = intervals.length;
  const avg = batchMedian(intervals);
  if (!Number.isFinite(avg)) return false;

  const trigger = getBatchTrigger(intervals);
  const val = trigger.value;
  const delta = consecutiveDelta(val);
  const inVegetal = !thresholdsEnabled || (val >= threshLo && val <= threshHi);
  const threshSpan = threshSpanUs();

  let interactionDepth = 0;
  if (val > threshHi) interactionDepth = clamp((val - threshHi) / (threshSpan * 2), 0, 1);
  else if (val < threshLo) interactionDepth = clamp((threshLo - val) / (threshSpan * 2), 0, 1);

  if (inVegetal) {
    if (!roleHasImpact("vegetal")) return false;
    return sonifyVegetalZone(intervals, avg, delta, now, batchLen);
  }

  if (!roleHasImpact("interaction")) {
    wasInInteraction = true;
    return false;
  }

  const entering = !wasInInteraction;
  wasInInteraction = true;
  const elapsed = now - lastNoteTime;
  const activity = clamp(0.55 + interactionDepth * 0.45, 0.55, 1);
  const gap = rateGapSec(activity);
  const strong = delta >= SPARKLE_THRESH_US || interactionDepth > 0.35;
  const burstGap = bpmMinGapSec() * 0.25;

  if (entering || strong) {
    if (elapsed < burstGap) return false;
  } else if (elapsed < gap) {
    return false;
  }

  playMappedNote("interaction", { t01: interactionDepth, time: now });
  markNotePlayed(now);
  return true;
}

// ─── Recording ───
const REC_DURATION = 60;
let recording = false;
let recData = [];
let recStart = 0;
let recTimer = null;

function toggleRecord() {
  if (recording) { stopRecord(); return; }
  recData = [];
  recStart = Date.now();
  recording = true;
  $("recToggle").classList.add("recording");
  $("settingsToggle").classList.add("recording");
  $("infoToggle")?.classList.add("recording");
  const timer = $("recTimer");
  timer.hidden = false;
  timer.style.display = "";
  updateRecTimer();
  recTimer = setInterval(updateRecTimer, 250);
}

function updateRecTimer() {
  const elapsed = (Date.now() - recStart) / 1000;
  const remaining = Math.max(0, REC_DURATION - elapsed);
  $("recTimer").textContent = remaining.toFixed(0) + "s";
  if (remaining <= 0) stopRecord();
}

function recordSamples(intervals) {
  const t = Date.now() - recStart;
  recData.push({ t, intervals_us: intervals });
}

function stopRecord() {
  recording = false;
  clearInterval(recTimer);
  $("recToggle").classList.remove("recording");
  $("settingsToggle").classList.remove("recording");
  $("infoToggle")?.classList.remove("recording");
  $("recTimer").hidden = true;

  if (recData.length === 0) return;

  const blob = new Blob(
    [JSON.stringify({ recorded_at: new Date().toISOString(), duration_s: REC_DURATION, samples: recData }, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "biodata-" + new Date().toISOString().slice(0, 19).replace(/:/g, "-") + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Graph ───

function visibleStart() {
  return Math.max(0, history.length - visibleCount);
}

function nudgePointSpacing(direction) {
  const next = direction > 0
    ? Math.round(visibleCount / SPAN_FACTOR)
    : Math.round(visibleCount * SPAN_FACTOR);
  visibleCount = clamp(next, MIN_VISIBLE_POINTS, MAX_VISIBLE_POINTS);
  updateSpanButtons();
  requestGraphRedraw();
}

function updateSpanButtons() {
  const plus = $("spanPlus");
  const minus = $("spanMinus");
  if (!plus || !minus) return;
  plus.disabled = visibleCount <= MIN_VISIBLE_POINTS;
  minus.disabled = visibleCount >= MAX_VISIBLE_POINTS;
}

const GRAPH_PAD = 4;
const ZOOM_FACTOR = 1.12;
const MIN_ZOOM_RANGE = 1200;
const MAX_ZOOM_RANGE = 200000;

function zoomGraphAtY(clientY, factor) {
  if (!isViewReady()) return;
  const range = viewRange();
  const canvas = $("graph");
  const h = canvas.clientHeight;
  const plotH = h - 2 * GRAPH_PAD;
  if (plotH < 1) return;

  const rect = canvas.getBoundingClientRect();
  const y = clientY - rect.top;
  const f = clamp((h - GRAPH_PAD - y) / plotH, 0, 1);
  const anchorVal = globalMin + f * range;
  const newRange = clamp(range * factor, MIN_ZOOM_RANGE, MAX_ZOOM_RANGE);

  globalMin = Math.round(anchorVal - f * newRange);
  globalMax = Math.round(anchorVal + (1 - f) * newRange);
  needStatsFlush = true;
  requestGraphRedraw();
}

function zoomGraphAtWheel(clientY, deltaY) {
  zoomGraphAtY(clientY, deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR);
}

function panGraphByDy(dy) {
  if (!isViewReady()) return;
  const plotH = canvas.clientHeight - 2 * GRAPH_PAD;
  if (plotH < 1) return;
  const delta = (dy / plotH) * viewRange();
  globalMin = Math.round(globalMin + delta);
  globalMax = Math.round(globalMax + delta);
  needStatsFlush = true;
  requestGraphRedraw();
}

function valToY(val, h, pad, range) {
  if (!Number.isFinite(val)) return h / 2;
  const y = h - pad - ((val - globalMin) / range) * (h - 2 * pad);
  return clamp(y, pad, h - pad);
}

function valInView(val) {
  return Number.isFinite(val) && val >= globalMin && val <= globalMax;
}

function yToVal(y, h, pad, range) {
  return globalMin + ((h - pad - y) / (h - 2 * pad)) * range;
}

let _lblHiCache = { top: -99999, text: "" };
let _lblLoCache = { top: -99999, text: "" };

function drawGraph() {
  const canvas = $("graph");
  const ctx = getGraphContext();
  if (!ensureCanvasBackingStore(canvas, ctx)) {
    if (performance.now() - dbgDrawSkipLog > 2000) {
      dbgDrawSkipLog = performance.now();
      dbgLog("WARN", "GRAPH", "Canvas non prêt", { w: canvas.clientWidth, h: canvas.clientHeight });
    }
    return;
  }
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = canvas._bkDpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (history.length < 2 || !isViewReady()) {
    if (performance.now() - dbgDrawSkipLog > 2000) {
      dbgDrawSkipLog = performance.now();
      dbgLog("WARN", "GRAPH", "Dessin ignoré", { hist: history.length, viewReady: isViewReady(), globalMin, globalMax });
    }
    return;
  }

  const range = viewRange();
  const pad = GRAPH_PAD;
  const start = visibleStart();
  const xDenom = Math.max(1, history.length - 1 - start);

  ctx.strokeStyle = "rgba(255,255,255,.04)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((h - 2 * pad) / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const yHi = valToY(threshHi, h, pad, range);
  const yLo = valToY(threshLo, h, pad, range);

  if (thresholdsEnabled) {
    ctx.fillStyle = "rgba(255, 160, 60, .04)";
    if (yHi > pad) ctx.fillRect(0, pad, w, yHi - pad);
    if (yLo < h - pad) ctx.fillRect(0, yLo, w, h - pad - yLo);
    ctx.fillStyle = "rgba(64, 145, 108, .03)";
    if (yLo > yHi) ctx.fillRect(0, yHi, w, yLo - yHi);
  }

  const xAt = (idx) => ((idx - start) / xDenom) * w;
  const inThreshZone = (val) => !thresholdsEnabled || (val >= threshLo && val <= threshHi);

  drawAmbianceHalos(ctx, start, xAt, h, pad, range);

  ctx.lineWidth = 2;
  let i = start + 1;
  while (i < history.length) {
    const inZone = inThreshZone(history[i]);
    ctx.strokeStyle = inZone ? "#40916c" : "#ffa03c";
    ctx.beginPath();
    ctx.moveTo(xAt(i - 1), valToY(history[i - 1], h, pad, range));
    while (i < history.length && inThreshZone(history[i]) === inZone) {
      ctx.lineTo(xAt(i), valToY(history[i], h, pad, range));
      i++;
    }
    ctx.stroke();
  }

  if (thresholdsEnabled) {
    drawThresholdLine(ctx, w, yHi, "rgba(255, 160, 60, .5)", [8, 4]);
    drawThresholdLine(ctx, w, yLo, "rgba(255, 160, 60, .5)", [8, 4]);
  }

  for (let j = start; j < history.length; j++) {
    if (!noteMarkers[j] || !valInView(history[j])) continue;
    const nx = xAt(j);
    const ny = valToY(history[j], h, pad, range);
    const inZone = inThreshZone(history[j]);

    ctx.beginPath();
    ctx.arc(nx, ny, 5, 0, Math.PI * 2);
    ctx.fillStyle = inZone ? "rgba(139, 196, 138, .2)" : "rgba(255, 160, 60, .2)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(nx, ny, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = inZone ? "#b5e6b0" : "#ffc470";
    ctx.fill();
  }

  drawNoteRipples(ctx, start, xAt, h, pad, range);

  const elHi = $("threshHiLabel");
  const elLo = $("threshLoLabel");
  if (thresholdsEnabled) {
    const hiTop = yHi - 10;
    const loTop = yLo - 10;
    const hiText = "▲ " + Math.round(threshHi).toLocaleString() + " µs";
    const loText = "▼ " + Math.round(threshLo).toLocaleString() + " µs";
    if (hiText !== _lblHiCache.text || Math.abs(hiTop - _lblHiCache.top) >= 1) {
      _lblHiCache = { top: hiTop, text: hiText };
      elHi.style.top = hiTop + "px";
      elHi.textContent = hiText;
    }
    if (loText !== _lblLoCache.text || Math.abs(loTop - _lblLoCache.top) >= 1) {
      _lblLoCache = { top: loTop, text: loText };
      elLo.style.top = loTop + "px";
      elLo.textContent = loText;
    }
  }

  updateCurrentZone();
}

function ambianceHaloVisible() {
  return !!(routing.ambiance && routing.ambiance.on);
}

function drawAmbianceHalos(ctx, start, xAt, h, pad, range) {
  if (!ambianceHaloVisible()) return;
  const n = history.length - start;
  if (n < 2) return;

  const energy = clamp(currentAmbientCv().energyN, 0, 1);
  const step = Math.max(4, (n / 40) | 0);
  let ema = history[start];
  const follow = 0.14;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = `rgba(80, 170, 235, ${0.16 + energy * 0.10})`;
  ctx.lineWidth = 16 + energy * 8;
  ctx.beginPath();
  ctx.moveTo(xAt(start), valToY(ema, h, pad, range));
  for (let j = start + 1; j < history.length; j++) {
    ema += (history[j] - ema) * follow;
    if (((j - start) % step) === 0 || j === history.length - 1) {
      ctx.lineTo(xAt(j), valToY(ema, h, pad, range));
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawThresholdLine(ctx, w, y, color, dash) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  ctx.restore();
}

function drawNoteRipples(ctx, start, xAt, h, pad, range) {
  if (!graphAnimations || noteRipples.length === 0) return;
  const now = performance.now();
  ctx.save();
  for (let i = 0; i < noteRipples.length; i++) {
    const r = noteRipples[i];
    const age = now - r.born;
    if (age < 0 || age >= RIPPLE_MS || r.idx < start || r.idx >= history.length) continue;
    if (!valInView(history[r.idx])) continue;
    const t = age / RIPPLE_MS;
    const ease = 1 - (1 - t) * (1 - t);
    const nx = xAt(r.idx);
    const ny = valToY(history[r.idx], h, pad, range);
    const radius = 5 + ease * 28;
    const alpha = (1 - t) * 0.55;
    const inZone = !thresholdsEnabled || (history[r.idx] >= threshLo && history[r.idx] <= threshHi);
    const rgb = inZone ? "139, 196, 138" : "255, 160, 60";
    ctx.beginPath();
    ctx.arc(nx, ny, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb}, ${alpha * 0.22})`;
    ctx.fill();
    ctx.lineWidth = 2 * (1 - t * 0.65);
    ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
    ctx.stroke();
  }
  ctx.restore();
}

function sensedZone() {
  if (!thresholdsEnabled || history.length < 1) return "vegetal";
  const from = Math.max(0, history.length - ZONE_LOOKBACK);
  for (let i = from; i < history.length; i++) {
    const v = history[i];
    if (v > threshHi || v < threshLo) return "interaction";
  }
  return "vegetal";
}

function updateCurrentZone() {
  if (history.length < 2) {
    zoneHoldUntil = 0;
    return;
  }

  const now = performance.now();
  const instant = sensedZone();
  if (instant === "interaction") zoneHoldUntil = now + ZONE_HOLD_MS;

  const newZone = (instant === "interaction" || now < zoneHoldUntil)
    ? "interaction"
    : "vegetal";

  if (newZone !== currentZone) {
    currentZone = newZone;
    syncFaustRoleGains();
  }
}

// ─── Drag handlers for threshold lines, pan and pinch ───

const canvas = $("graph");

function thresholdHit(clientY, snap = DRAG_SNAP_PX) {
  if (G.dynamicThresholds || !thresholdsEnabled || history.length < 2 || !isViewReady()) return null;
  const range = viewRange();
  const h = canvas.clientHeight;
  const pad = GRAPH_PAD;
  const y = clientY - canvas.getBoundingClientRect().top;
  const yHi = valToY(threshHi, h, pad, range);
  const yLo = valToY(threshLo, h, pad, range);
  if (Math.abs(y - yHi) < snap) return "hi";
  if (Math.abs(y - yLo) < snap) return "lo";
  return null;
}

function touchDist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function beginPinch(t0, t1) {
  if (G.autoZoom) {
    pinch = null;
    return;
  }
  dragging = null;
  panning = false;
  canvas.classList.remove("dragging", "panning");
  const dist = touchDist(t0, t1);
  if (dist < 10 || !isViewReady()) {
    pinch = null;
    return;
  }
  const midY = (t0.clientY + t1.clientY) / 2;
  const h = canvas.clientHeight;
  const plotH = h - 2 * GRAPH_PAD;
  const rect = canvas.getBoundingClientRect();
  const y = midY - rect.top;
  pinch = {
    dist,
    midY,
    frac: plotH < 1 ? 0.5 : clamp((h - GRAPH_PAD - y) / plotH, 0, 1),
    min: globalMin,
    range: viewRange(),
  };
}

function movePinch(t0, t1) {
  if (!pinch || !isViewReady()) return;
  const dist = touchDist(t0, t1);
  if (dist < 10) return;
  const midY = (t0.clientY + t1.clientY) / 2;
  const plotH = canvas.clientHeight - 2 * GRAPH_PAD;
  if (plotH < 1) return;
  const newRange = clamp(pinch.range * (pinch.dist / dist), MIN_ZOOM_RANGE, MAX_ZOOM_RANGE);
  const pan = G.autoCenter ? 0 : ((midY - pinch.midY) / plotH) * pinch.range;
  const anchor = pinch.min + pinch.frac * pinch.range;
  globalMin = Math.round(anchor - pinch.frac * newRange + pan);
  globalMax = Math.round(globalMin + newRange);
  needStatsFlush = true;
  requestGraphRedraw();
}

function endGraphGesture() {
  pinch = null;
  panning = false;
  canvas.classList.remove("panning");
  if (dragging) {
    threshHi = Math.round(threshHi);
    threshLo = Math.round(threshLo);
    dragging = null;
    canvas.classList.remove("dragging");
  }
}

canvas.addEventListener("wheel", (e) => {
  if (!isViewReady() || G.autoZoom) return;
  e.preventDefault();
  zoomGraphAtWheel(e.clientY, e.deltaY);
}, { passive: false });

canvas.addEventListener("auxclick", (e) => {
  if (e.button === 1) e.preventDefault();
});

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 1 || e.button === 0) {
    if (history.length < 2 || !isViewReady()) return;
    if (e.button === 0) {
      const hit = thresholdHit(e.clientY);
      if (hit) {
        dragging = hit;
        canvas.classList.add("dragging");
        e.preventDefault();
        return;
      }
    }
    if (G.autoCenter) return;
    panning = true;
    panLastY = e.clientY;
    canvas.classList.add("panning");
    e.preventDefault();
  }
});

let hoverCursorRaf = null;
let pendingHoverClientY = 0;

window.addEventListener("mousemove", (e) => {
  if (panning) {
    panGraphByDy(e.clientY - panLastY);
    panLastY = e.clientY;
    return;
  }

  if (!dragging) {
    if (history.length < 2) return;
    pendingHoverClientY = e.clientY;
    if (hoverCursorRaf != null) return;
    hoverCursorRaf = requestAnimationFrame(() => {
      hoverCursorRaf = null;
      const nearLine = thresholdHit(pendingHoverClientY);
      canvas.style.cursor = nearLine ? "ns-resize" : "default";
    });
    return;
  }

  const range = viewRange();
  const h = canvas.clientHeight;
  const pad = GRAPH_PAD;
  const val = yToVal(e.clientY - canvas.getBoundingClientRect().top, h, pad, range);

  if (dragging === "hi") {
    threshHi = Math.round(Math.max(threshLo + 50, Math.min(globalMax, val)));
  } else {
    threshLo = Math.round(Math.min(threshHi - 50, Math.max(globalMin, val)));
  }

  requestGraphRedraw();
});

window.addEventListener("mouseup", endGraphGesture);

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length >= 2) {
    beginPinch(e.touches[0], e.touches[1]);
    return;
  }
  if (history.length < 2 || !isViewReady()) return;
  pinch = null;
  const t = e.touches[0];
  const hit = thresholdHit(t.clientY, DRAG_SNAP_PX * 2);
  if (hit) {
    dragging = hit;
    panning = false;
    canvas.classList.add("dragging");
    canvas.classList.remove("panning");
    return;
  }
  if (G.autoCenter) return;
  dragging = null;
  panning = true;
  panLastY = t.clientY;
  canvas.classList.add("panning");
  canvas.classList.remove("dragging");
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (e.touches.length >= 2) {
    if (!pinch) beginPinch(e.touches[0], e.touches[1]);
    else movePinch(e.touches[0], e.touches[1]);
    return;
  }
  if (pinch) return;
  if (panning) {
    panGraphByDy(e.touches[0].clientY - panLastY);
    panLastY = e.touches[0].clientY;
    return;
  }
  if (!dragging) return;
  const range = viewRange();
  const h = canvas.clientHeight;
  const pad = GRAPH_PAD;
  const val = yToVal(e.touches[0].clientY - canvas.getBoundingClientRect().top, h, pad, range);

  if (dragging === "hi") {
    threshHi = Math.round(Math.max(threshLo + 50, Math.min(globalMax, val)));
  } else {
    threshLo = Math.round(Math.min(threshHi - 50, Math.max(globalMin, val)));
  }

  requestGraphRedraw();
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
  if (e.touches.length >= 2) return;
  if (e.touches.length === 1) {
    pinch = null;
    dragging = null;
    panning = true;
    panLastY = e.touches[0].clientY;
    canvas.classList.add("panning");
    canvas.classList.remove("dragging");
    return;
  }
  endGraphGesture();
}, { passive: false });

canvas.addEventListener("touchcancel", endGraphGesture, { passive: false });

window.addEventListener("resize", () => {
  canvas._bkW = -1;
  requestGraphRedraw();
});

// ─── Pulsation du contour des pistes ───
const pipLevel = { ambiance: 0, vegetal: 0, interaction: 0 };
const pipEls = {};
let pipRaf = 0;
let pipLast = 0;

document.querySelectorAll(".role-pip").forEach((el) => {
  pipEls[el.dataset.role] = el;
});

function rolePipTarget(role, now) {
  if (!routing[role] || !routing[role].on) return 0;
  if (history.length < 2 || lastPulseAt <= 0) return 0;
  const age = (now - lastPulseAt) / 1000;
  const hold = 0.45;
  const dur = 2.6;
  let presence = 1;
  if (age > hold) presence = expDecayGain((age - hold) / dur);
  if (presence < 0.02) return 0;
  const cv = currentAmbientCv();
  const alive = clamp(Math.max(cv.energyN, cv.liveN), 0, 1);
  let gate = 1;
  if (thresholdsEnabled && role === "interaction") {
    if (audioEnabled) gate = roleZoneGate(role);
    else gate = currentZone === "interaction" ? 1 : 0;
  }
  if (gate < 0.03) return 0;
  const floor = role === "ambiance" ? 0.3 : 0.45;
  return presence * gate * (floor + (1 - floor) * alive);
}

const pipStrCache = { ambiance: "", vegetal: "", interaction: "" };

function tickRolePips(now) {
  if (audioEnabled) {
    try { tickModulation(); } catch (err) { dbgError("MOD", err); }
  }
  const dt = pipLast ? Math.min(0.05, (now - pipLast) / 1000) : 0.016;
  pipLast = now;
  const k = 1 - Math.exp(-dt / 0.16);
  for (const role of ROLE_IDS) {
    const el = pipEls[role];
    if (!el) continue;
    const target = rolePipTarget(role, now);
    pipLevel[role] += (target - pipLevel[role]) * k;
    const level = pipLevel[role];
    const freq = 0.5 + level * 1.8;
    const wave = level < 0.02 ? 0 : 0.5 + 0.5 * Math.sin(now * 0.001 * freq * Math.PI * 2);
    const valStr = (level * (0.25 + 0.75 * wave)).toFixed(3);
    if (pipStrCache[role] !== valStr) {
      pipStrCache[role] = valStr;
      el.style.setProperty("--pip", valStr);
    }
  }
  pipRaf = requestAnimationFrame(tickRolePips);
}

function startRolePips() {
  if (pipRaf) return;
  pipLast = 0;
  pipRaf = requestAnimationFrame(tickRolePips);
}

function stopRolePips() {
  if (!pipRaf) return;
  cancelAnimationFrame(pipRaf);
  pipRaf = 0;
  pipLast = 0;
}

// ─── Démarrage ───
// La page est servie par le Pico : le flux et le son partent avec la fenêtre.
updateSpanButtons();
setThresholdsEnabled(!!routing.interaction.on);
maybePrefetchFaust();
unlockAudio();
connect();
document.addEventListener("pointerdown", unlockAudio, { capture: true });
document.addEventListener("keydown", unlockAudio, { capture: true });

// Un téléphone suspend l'onglet dès qu'il se verrouille : au retour, le flux et
// le contexte audio doivent être relancés.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopRolePips();
    return;
  }
  startRolePips();
  if (streamWanted && !streamLive) connect();
  if (audioEnabled) resumeFaustContexts();
});

startRolePips();
