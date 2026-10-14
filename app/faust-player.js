/**
 * Lecteur des patches Faust précompilés (Teasynth / Ambient Garden).
 * Un seul AudioContext partagé, mixés via un limiteur.
 * AudioWorklet en HTTPS/localhost, ScriptProcessor sur le Pico (HTTP).
 */
(function (global) {
  "use strict";

  const catalog = (global.FAUST_CATALOG && global.FAUST_CATALOG.patches) || [];
  const DSP_HASHES = global.FAUST_DSP_HASHES || {};
  const PATCHES = {};
  const DSP_FILES = {};
  for (let i = 0; i < catalog.length; i++) {
    const patch = catalog[i];
    PATCHES[patch.id] = patch.id;
    DSP_FILES[patch.id] = patch.dsp || [];
  }

  const PARAM_SAFE_MAX = {
    fb: 0.82,
    delfb: 0.86,
    preamp: 1.12,
    tightness: 5.2,
    impact: 0.95,
  };
  const PARAM_SAFE_MIN = {
    density: 0.06,
    freq1: 20,
    freq2: 20,
    freq3: 20,
    minFreq: 20,
    maxFreq: 20,
    lp: 40,
    lp1: 40,
    hp1: 20,
  };
  const FREQ_PARAM = /^(freq\d*|minFreq|maxFreq|lp\d*|hp\d*|lp|hp)$/;
  const DRONE_KINDS = {
    "sine-drone": true,
    "soprano-drone": true,
    "resonant-drone": true,
    "harmonic-series": true,
    "vocal-overtones": true,
    "contrabass": true,
  };

  const cyrb53 = (str, seed = 0) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  };

  const cache = {};
  async function cachedFetch(url, format) {
    const key = format + ":" + url;
    if (cache[key]) return cache[key];
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Faust fetch " + resp.status + " " + url);
    const val =
      format === "txt" ? await resp.text() :
      format === "json" ? await resp.json() :
      await resp.arrayBuffer();
    cache[key] = val;
    return val;
  }

  const slots = Object.create(null);
  let startChain = Promise.resolve();
  const booted = {};
  let sharedCtx = null;
  const addedWorklets = new WeakMap();
  let slewTimer = null;

  function rootFor(name) {
    return "/faust/" + name + "/";
  }

  function compileCallbacks(name) {
    const workletRoot = rootFor(name);
    const hashes = DSP_HASHES[name] || {};
    return {
      fetchMainRelative(path) {
        if (hashes[path] != null) return Promise.resolve("\0HASH:" + hashes[path]);
        return cachedFetch(workletRoot + path, "txt");
      },
      async compileFaust(code) {
        const hash = code.indexOf("\0HASH:") === 0 ? code.slice(6) : cyrb53(code);
        const ui8Code = await cachedFetch(workletRoot + hash + ".wasm", "buf");
        const dspMeta = await cachedFetch(workletRoot + hash + ".json", "json");
        return [ui8Code, dspMeta];
      },
    };
  }

  function canUseWorklet() {
    if (/\bfaust=script\b/.test(global.location.search)) return false;
    return !!(global.isSecureContext && global.AudioWorkletNode);
  }

  function slotOfKind(kind) {
    for (const slot of Object.keys(slots)) {
      if (slots[slot] && slots[slot].kind === kind) return slot;
    }
    return null;
  }

  function makeClipCurve() {
    const n = 257;
    const curve = new Float32Array(n);
    const k = 1.15;
    const den = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / den;
    }
    return curve;
  }

  function setupMaster(ctx) {
    if (ctx._gardenMaster && ctx.state !== "closed") return ctx._gardenMaster;
    const master = ctx.createGain();
    master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    const clip = ctx.createWaveShaper();
    clip.curve = makeClipCurve();
    clip.oversample = "none";
    master.connect(comp);
    comp.connect(clip);
    clip.connect(ctx.destination);
    ctx._gardenMaster = master;
    ctx._gardenComp = comp;
    ctx._gardenClip = clip;
    return master;
  }

  function wrapWorkletSource(src, processorName) {
    const escaped = processorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("registerProcessor\\(\\s*(['\"])" + escaped + "\\1\\s*,\\s*([^)]+)\\)");
    return src.replace(re, (_, quote, klass) => (
      "registerProcessor(" + quote + processorName + quote + ",(function(Base){" +
      "return class extends Base{" +
      "constructor(o){super(o);this._bad=0;this._told=0}" +
      "process(i,o,p){" +
      "let ok=true;" +
      "try{ok=super.process(i,o,p)}" +
      "catch(e){" +
      "const ch=o&&o[0];if(ch){for(let c=0;c<ch.length;c++)ch[c].fill(0)}" +
      "this._report('throw');return true}" +
      "const ch=o&&o[0];if(!ch||!ch.length)return ok!==false;" +
      "let bad=false,peak=0;" +
      "for(let c=0;c<ch.length;c++){" +
      "const b=ch[c];" +
      "for(let n=0;n<b.length;n++){" +
      "let s=b[n];" +
      "if(s!==s||s===Infinity||s===-Infinity){b[n]=0;bad=true;continue}" +
      "const a=s<0?-s:s;if(a>peak)peak=a;" +
      "if(a>1.6)b[n]=s>0?1.6+(s-1.6)*0.08:-1.6+(s+1.6)*0.08" +
      "}}" +
      "if(bad||peak>10){this._bad++;if(this._bad>18)this._report(bad?'nan':'hot')}" +
      "else this._bad=this._bad>1?this._bad-2:0;" +
      "return ok!==false}" +
      "_report(why){if(currentTime-this._told<0.45)return;this._told=currentTime;" +
      "try{this.port.postMessage({type:'dsp fault',why:why})}catch(e){}}" +
      "}})(" + klass + "))"
    ));
  }

  async function addWorkletModule(ctx, url, processorName) {
    let added = addedWorklets.get(ctx);
    if (!added) {
      added = new Set();
      addedWorklets.set(ctx, added);
    }
    if (added.has(processorName)) return;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("worklet " + resp.status);
      const wrapped = wrapWorkletSource(await resp.text(), processorName);
      const blob = new Blob([wrapped], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (_) {
      await ctx.audioWorklet.addModule(url);
    }
    added.add(processorName);
  }

  function getSharedContext(wantRate) {
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    sharedCtx = new AudioContext({
      sampleRate: wantRate || 44100,
      latencyHint: "playback",
    });
    setupMaster(sharedCtx);
    return sharedCtx;
  }

  async function recreateSharedContext(wantRate) {
    const old = sharedCtx;
    sharedCtx = new AudioContext({
      sampleRate: wantRate || (old && old.sampleRate) || 44100,
      latencyHint: "playback",
    });
    setupMaster(sharedCtx);
    if (old && old.state !== "closed") {
      try { await old.close(); } catch (_) { /* déjà fermé */ }
    }
    return sharedCtx;
  }

  function attachMeter(patch) {
    try {
      const meter = patch.ctx.createAnalyser();
      meter.fftSize = 256;
      meter.smoothingTimeConstant = 0;
      patch.gain.connect(meter);
      patch.meter = meter;
      patch.meterBuf = new Float32Array(meter.fftSize);
    } catch (_) { /* analyseur indisponible */ }
  }

  function attachFaultMeter(patch, node) {
    if (!node) return;
    try {
      const meter = patch.ctx.createAnalyser();
      meter.fftSize = 256;
      meter.smoothingTimeConstant = 0;
      node.connect(meter);
      patch.faultMeter = meter;
      patch.faultBuf = new Float32Array(meter.fftSize);
    } catch (_) { /* */ }
  }

  function wireGraph(audioContext, node) {
    const clip = audioContext.createWaveShaper();
    clip.curve = makeClipCurve();
    clip.oversample = "none";
    const duck = audioContext.createGain();
    duck.gain.value = 1;
    const gain = audioContext.createGain();
    gain.gain.value = 0.0001;
    node.connect(clip);
    clip.connect(duck);
    duck.connect(gain);
    gain.connect(setupMaster(audioContext));
    return { clip, duck, gain };
  }

  function sanitizeParam(name, val) {
    if (!Number.isFinite(val)) return null;
    let next = val;
    if (name in PARAM_SAFE_MAX && next > PARAM_SAFE_MAX[name]) next = PARAM_SAFE_MAX[name];
    if (name in PARAM_SAFE_MIN && next < PARAM_SAFE_MIN[name]) next = PARAM_SAFE_MIN[name];
    return next;
  }

  function clampToSpec(patch, name, val) {
    const spec = patch.params && patch.params[name];
    if (!spec) return val;
    let next = val;
    if (Number.isFinite(spec.min) && next < spec.min) next = spec.min;
    if (Number.isFinite(spec.max) && next > spec.max) next = spec.max;
    return next;
  }

  function markBroken(patch, why) {
    if (!patch) return;
    patch.broken = true;
    patch.breakWhy = why || "nan";
  }

  function listenFaults(patch, node) {
    if (!node) return;
    node.addEventListener("processorerror", () => markBroken(patch, "error"));
    if (!node.port) return;
    node.port.addEventListener("message", (event) => {
      if (event.data && event.data.type === "dsp fault") markBroken(patch, event.data.why || "nan");
    });
  }

  function slewToward(name, cur, tgt, dt) {
    if (!Number.isFinite(cur)) return tgt;
    const step = Math.max(dt, 0.001);
    if (FREQ_PARAM.test(name)) {
      const octPerSec = name.indexOf("freq") === 0 || name === "minFreq" || name === "maxFreq" ? 3.2 : 10;
      const maxRatio = Math.pow(2, octPerSec * step);
      const from = Math.max(cur, 8);
      if (tgt > from * maxRatio) return from * maxRatio;
      if (tgt < from / maxRatio) return from / maxRatio;
      return tgt;
    }
    if (name === "fb" || name === "delfb") {
      const maxD = 1.2 * step;
      if (tgt > cur + maxD) return cur + maxD;
      if (tgt < cur - maxD) return cur - maxD;
      return tgt;
    }
    const tau = name === "tightness" || name === "density" ? 0.12 : 0.07;
    const coeff = 1 - Math.exp(-step / tau);
    return cur + (tgt - cur) * coeff;
  }

  function sendParam(patch, name, val) {
    if (patch.setParamFn) {
      try { patch.setParamFn(name, val); } catch (_) { markBroken(patch, "error"); }
      return;
    }
    if (!patch.node || !patch.node.port) return;
    try {
      patch.node.port.postMessage({ type: "set param", name, val });
    } catch (_) { /* port fermé */ }
  }

  function ensureSlewLoop() {
    if (slewTimer != null) return;
    const step = () => {
      slewTimer = null;
      if (!Object.keys(slots).length) return;
      tickParamSlew();
      slewTimer = (global.setTimeout || setTimeout)(step, 16);
    };
    slewTimer = (global.setTimeout || setTimeout)(step, 16);
  }

  function tickParamSlew() {
    const ctx = sharedCtx;
    if (!ctx || ctx.state === "closed") return;
    const now = ctx.currentTime;
    for (const slot of Object.keys(slots)) {
      const patch = slots[slot];
      if (!patch || !patch.paramTargets) continue;
      const dt = Math.min(0.05, Math.max(0.008, now - (patch.slewAt || now)));
      patch.slewAt = now;
      const names = Object.keys(patch.paramTargets);
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const target = patch.paramTargets[name];
        const cur = patch.lastParams[name];
        if (cur == null) {
          patch.lastParams[name] = target;
          sendParam(patch, name, target);
          continue;
        }
        if (Math.abs(cur - target) < 1e-4) continue;
        const next = slewToward(name, cur, target, dt);
        patch.lastParams[name] = next;
        sendParam(patch, name, next);
      }
    }
  }

  function blankPatch(name, kind, ctx, mode) {
    return {
      name,
      kind,
      ctx,
      node: null,
      gain: null,
      duck: null,
      clip: null,
      params: {},
      lastParams: {},
      paramTargets: {},
      lastGain: 0.0001,
      duckGain: 1,
      mode,
      broken: false,
      breakWhy: "",
      silentChecks: 0,
      startedAt: (global.performance && performance.now()) || Date.now(),
    };
  }

  async function startWorklet(name, kind, initParams) {
    const workletRoot = rootFor(name);
    const processorName = "worklet_" + name;
    const callbacks = compileCallbacks(name);
    let ctx = getSharedContext(44100);
    const patch = blankPatch(name, kind, ctx, "worklet");

    const attach = async (audioContext) => {
      await addWorkletModule(audioContext, workletRoot + processorName + ".js", processorName);
      const node = new AudioWorkletNode(audioContext, processorName, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const graph = wireGraph(audioContext, node);
      patch.node = node;
      patch.gain = graph.gain;
      patch.duck = graph.duck;
      patch.clip = graph.clip;
      patch.ctx = audioContext;
      listenFaults(patch, node);

      const rcvHostCmd = async (data) => {
        const resp = { type: "hostResp", cmdId: data.cmdId };
        if (data.cmd === "fetchMainRelative") {
          resp.content = await callbacks.fetchMainRelative(data.path);
        } else if (data.cmd === "compileFaust") {
          const ret = await callbacks.compileFaust(data.code);
          resp.ui8Code = ret[0];
          resp.dspMeta = ret[1];
        } else if (data.cmd === "defineParams") {
          patch.params = {};
          for (const spec of data.paramSpecs || []) patch.params[spec.name] = spec;
        }
        node.port.postMessage(resp);
      };

      node.port.addEventListener("message", (event) => {
        if (event.data.type === "runHostCmd") rcvHostCmd(event.data);
      });

      const result = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("Timeout Faust " + name)), 20000);
        const ready = (event) => {
          if (event.data.type === "main ready" || event.data.type === "wrong samplerate") {
            node.port.removeEventListener("message", ready);
            clearTimeout(t);
            resolve(event.data);
          }
        };
        node.port.addEventListener("message", ready);
        node.port.start();
        node.port.postMessage({ type: "init main", initParams: initParams || {} });
      });
      return result;
    };

    let result = await attach(ctx);
    if (result.type === "wrong samplerate") {
      const busy = Object.keys(slots).length > 0;
      if (!busy) {
        ctx = await recreateSharedContext(result.wantRate);
        result = await attach(ctx);
      }
    }
    if (result.type !== "main ready") {
      try { patch.node && patch.node.disconnect(); } catch (_) { /* */ }
      try { patch.gain && patch.gain.disconnect(); } catch (_) { /* */ }
      try { patch.duck && patch.duck.disconnect(); } catch (_) { /* */ }
      try { patch.clip && patch.clip.disconnect(); } catch (_) { /* */ }
      throw new Error("Faust worklet: " + (result.type || "échec"));
    }
    if (ctx.state === "suspended") await ctx.resume();
    attachMeter(patch);
    attachFaultMeter(patch, patch.node);
    patch.startedAt = (global.performance && performance.now()) || Date.now();
    ensureSlewLoop();
    return patch;
  }

  function sanitizeBuffer(buf, patch) {
    let bad = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i];
      if (!Number.isFinite(s)) {
        buf[i] = 0;
        bad++;
        continue;
      }
      if (s > 1.6 || s < -1.6) buf[i] = Math.tanh(s);
    }
    if (bad > 24) markBroken(patch, "nan");
    return bad;
  }

  async function startScript(name, kind) {
    const callbacks = compileCallbacks(name);
    const url = rootFor(name) + "patch.js";
    const mod = await import(url);
    const wantRate = mod.sampleRate || 44100;
    const ctx = getSharedContext(wantRate);
    let engine = booted[name];
    if (!engine) {
      engine = await mod.boot({
        sampleRate: ctx.sampleRate,
        fetchMainRelative: callbacks.fetchMainRelative,
        compileFaust: callbacks.compileFaust,
      });
      booted[name] = engine;
    }
    const bufSize = 2048;
    const proc = ctx.createScriptProcessor(bufSize, 1, 2);
    const graph = wireGraph(ctx, proc);
    const patch = blankPatch(name, kind, ctx, "script");
    patch.node = proc;
    patch.gain = graph.gain;
    patch.duck = graph.duck;
    patch.clip = graph.clip;
    patch.setParamFn = engine.setParam;
    proc.onaudioprocess = (ev) => {
      const left = ev.outputBuffer.getChannelData(0);
      const right = ev.outputBuffer.getChannelData(1);
      try {
        engine.fill(left, right);
      } catch (_) {
        left.fill(0);
        right.fill(0);
        markBroken(patch, "error");
        return;
      }
      sanitizeBuffer(left, patch);
      sanitizeBuffer(right, patch);
    };
    if (ctx.state === "suspended") await ctx.resume();
    attachMeter(patch);
    attachFaultMeter(patch, proc);
    patch.startedAt = (global.performance && performance.now()) || Date.now();
    ensureSlewLoop();
    return patch;
  }

  async function createPatch(kind, initParams) {
    const name = PATCHES[kind] || kind;
    return canUseWorklet()
      ? await startWorklet(name, kind, initParams)
      : await startScript(name, kind);
  }

  async function disposePatch(patch) {
    if (!patch) return;
    if (patch.broken) delete booted[patch.name];
    try {
      if (patch.gain && patch.ctx && patch.ctx.state !== "closed") {
        const t = patch.ctx.currentTime;
        patch.gain.gain.cancelScheduledValues(t);
        patch.gain.gain.setTargetAtTime(0.0001, t, 0.03);
      }
    } catch (_) { /* déjà fermé */ }
    await new Promise((r) => setTimeout(r, 50));
    try { if (patch.node) patch.node.onaudioprocess = null; } catch (_) { /* script */ }
    try { patch.node && patch.node.disconnect(); } catch (_) { /* déjà déconnecté */ }
    try { patch.clip && patch.clip.disconnect(); } catch (_) { /* */ }
    try { patch.duck && patch.duck.disconnect(); } catch (_) { /* */ }
    try { patch.gain && patch.gain.disconnect(); } catch (_) { /* déjà déconnecté */ }
    try { patch.meter && patch.meter.disconnect(); } catch (_) { /* */ }
    try { patch.faultMeter && patch.faultMeter.disconnect(); } catch (_) { /* */ }
  }

  async function stopSlot(slot) {
    const patch = slots[slot];
    if (!patch) return;
    delete slots[slot];
    await disposePatch(patch);
  }

  async function startSlot(slot, kind, initParams) {
    if (slots[slot] && slots[slot].kind === kind && !slots[slot].broken) return slots[slot];
    const taken = slotOfKind(kind);
    if (taken && taken !== slot) await stopSlot(taken);
    await stopSlot(slot);
    const patch = await createPatch(kind, initParams);
    patch.slot = slot;
    slots[slot] = patch;
    ensureSlewLoop();
    return patch;
  }

  function queueStart(slot, kind, initParams) {
    const task = startChain.then(() => startSlot(slot, kind, initParams));
    startChain = task.catch(() => {});
    return task;
  }

  function patchOf(slot) {
    return slots[slot] || null;
  }

  function setParam(slot, name, val) {
    const patch = typeof slot === "string" ? slots[slot] : slot;
    if (!patch) return;
    let next = sanitizeParam(name, val);
    if (next == null) return;
    if (patch.params && Object.keys(patch.params).length && !(name in patch.params)) return;
    next = clampToSpec(patch, name, next);
    patch.paramTargets[name] = next;
    if (patch.lastParams[name] == null) {
      patch.lastParams[name] = next;
      sendParam(patch, name, next);
    }
    ensureSlewLoop();
  }

  function setGain(slot, val, now) {
    const patch = typeof slot === "string" ? slots[slot] : slot;
    if (!patch || !patch.gain || !patch.ctx || patch.ctx.state === "closed") return;
    const next = Math.max(val, 0.0001);
    const prev = patch.lastGain || 0;
    const scale = Math.max(prev, next, 0.0001);
    if (Math.abs(prev - next) < Math.max(0.00008, scale * 0.035)) return;
    patch.lastGain = next;
    try {
      const t = now ?? patch.ctx.currentTime;
      const g = patch.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.setTargetAtTime(next, t, 0.06);
    } catch (_) { /* contexte fermé */ }
  }

  function applyDuck(patch, amount) {
    if (!patch || !patch.duck || !patch.ctx || patch.ctx.state === "closed") return;
    const next = Math.max(0.05, Math.min(1, amount));
    if (Math.abs((patch.duckGain || 1) - next) < 0.02) return;
    patch.duckGain = next;
    try {
      const t = patch.ctx.currentTime;
      patch.duck.gain.cancelScheduledValues(t);
      patch.duck.gain.setTargetAtTime(next, t, 0.05);
    } catch (_) { /* */ }
  }

  function readAnalyserPeak(meter, buf) {
    if (!meter || !buf) return null;
    try {
      meter.getFloatTimeDomainData(buf);
    } catch (_) {
      return null;
    }
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i];
      if (!Number.isFinite(s)) return NaN;
      const a = Math.abs(s);
      if (a > peak) peak = a;
    }
    return peak;
  }

  function readPeak(patch) {
    if (!patch) return null;
    return readAnalyserPeak(patch.meter, patch.meterBuf);
  }

  function readFaultPeak(patch) {
    if (!patch) return null;
    const peak = readAnalyserPeak(patch.faultMeter, patch.faultBuf);
    return peak == null ? readPeak(patch) : peak;
  }

  function inspectPatch(patch) {
    if (!patch) return null;
    if (patch.broken) return patch.breakWhy || "nan";
    if (patch.ctx && patch.ctx.state === "closed") return "dead";
    const now = (global.performance && performance.now()) || Date.now();
    if (now - (patch.startedAt || 0) < 900) return null;
    const raw = readFaultPeak(patch);
    if (raw == null) return null;
    if (!Number.isFinite(raw)) return "nan";
    if (raw > 1.3) applyDuck(patch, Math.min(1, 0.85 / raw));
    else applyDuck(patch, 1);
    if (raw > 14) return "hot";
    const audible = readPeak(patch);
    if (DRONE_KINDS[patch.kind] && (patch.lastGain || 0) > 0.05 && Number.isFinite(audible) && audible < 1.5e-7) {
      patch.silentChecks = (patch.silentChecks || 0) + 1;
      if (patch.silentChecks > 45) return "silent";
    } else {
      patch.silentChecks = 0;
    }
    return null;
  }

  function peakLevel(slot) {
    const patch = typeof slot === "string" ? slots[slot] : slot;
    const peak = readPeak(patch);
    return Number.isFinite(peak) ? peak : 0;
  }

  function healthCheck() {
    const bad = [];
    let reset = false;
    for (const slot of Object.keys(slots)) {
      const patch = slots[slot];
      const why = inspectPatch(patch);
      if (!why) continue;
      bad.push({ slot, kind: patch.kind, why });
      if (why === "dead" && patch.ctx && patch.ctx.state === "closed") reset = true;
    }
    return { bad, reset };
  }

  async function stopAll(opts) {
    const names = Object.keys(slots);
    await Promise.all(names.map((slot) => stopSlot(slot)));
    const closeContext = !opts || opts.closeContext !== false;
    if (closeContext && sharedCtx) {
      try { await sharedCtx.close(); } catch (_) { /* déjà fermé */ }
      sharedCtx = null;
    }
  }

  async function prefetch(kinds) {
    const list = kinds && kinds.length ? kinds : Object.keys(PATCHES);
    for (const kind of list) {
      const name = PATCHES[kind] || kind;
      if (!name) continue;
      const cbs = compileCallbacks(name);
      const files = DSP_FILES[name] || [];
      for (let i = 0; i < files.length; i++) {
        const code = await cbs.fetchMainRelative(files[i]);
        await cbs.compileFaust(code);
      }
      if (!canUseWorklet()) {
        await import(rootFor(name) + "patch.js");
      }
    }
  }

  global.FaustGarden = {
    PATCHES,
    isKind: (k) => k in PATCHES,
    start: queueStart,
    stop: stopSlot,
    stopAll,
    setParam,
    setGain,
    get: patchOf,
    slotOfKind,
    prefetch,
    healthCheck,
    peakLevel,
    get current() { return slots.ambiance || Object.values(slots)[0] || null; },
    get slots() { return slots; },
  };
})(window);
