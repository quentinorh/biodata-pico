/**
 * Lecteur des patches Faust précompilés (Teasynth / Ambient Garden).
 * Un seul AudioContext partagé, mixés via un limiteur.
 * AudioWorklet en HTTPS/localhost, ScriptProcessor mixeur unique sur le Pico (HTTP).
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
    density: 0.08,
    freq1: 22,
    freq2: 22,
    freq3: 22,
    minFreq: 40,
    maxFreq: 60,
    lp: 45,
    lp1: 45,
    hp1: 30,
  };
  const FREQ_PARAM = /^(freq\d*|minFreq|maxFreq|lp\d*|hp\d*|lp|hp)$/;
  const DRONE_KINDS = {
    "sine-drone": true,
    "soprano-drone": true,
    "resonant-drone": true,
    "harmonic-series": true,
    "vocal-overtones": true,
    contrabass: true,
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
  const pendingFetch = {};
  async function cachedFetch(url, format) {
    const key = format + ":" + url;
    if (cache[key]) return cache[key];
    if (pendingFetch[key]) return pendingFetch[key];
    pendingFetch[key] = (async () => {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Faust fetch " + resp.status + " " + url);
        const val =
          format === "txt" ? await resp.text() :
          format === "json" ? await resp.json() :
          await resp.arrayBuffer();
        cache[key] = val;
        return val;
      } finally {
        delete pendingFetch[key];
      }
    })();
    return pendingFetch[key];
  }

  const slots = Object.create(null);
  const slotChains = Object.create(null);
  const booted = {};
  let sharedCtx = null;
  let sharedScriptProc = null;
  const addedWorklets = new WeakMap();
  let slewTimer = null;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(
    (global.navigator && global.navigator.userAgent) || ""
  );

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

  // Réverbes d'église : réponses impulsionnelles synthétiques, en envoi sur le bus master.
  // rt60 : décroissance de 60 dB (s) ; damp : fréquence de coupure de la queue en fin de décroissance.
  const REVERBS = {
    romane: { label: "Église romane", rt60: 3.6, pre: 0.022, early: 0.5, bright: 6500, damp: 1400, lowcut: 110 },
    abbatiale: { label: "Abbatiale", rt60: 5.2, pre: 0.034, early: 0.42, bright: 7000, damp: 1100, lowcut: 95 },
    cathedrale: { label: "Cathédrale gothique", rt60: 7.4, pre: 0.048, early: 0.36, bright: 7500, damp: 900, lowcut: 85 },
    basilique: { label: "Basilique", rt60: 10.5, pre: 0.065, early: 0.3, bright: 6800, damp: 750, lowcut: 75 },
    crypte: { label: "Crypte sous la nef", rt60: 4.6, pre: 0.012, early: 0.7, bright: 3200, damp: 520, lowcut: 140 },
  };
  const reverbState = { id: "", mix: 0.35 };
  const irCache = Object.create(null);

  function buildChurchIR(ctx, spec, seed) {
    const sr = ctx.sampleRate;
    // Sur mobile la queue s'arrête à -40 dB : un tiers de convolution en moins, l'oreille ne l'entend pas sous les drones.
    const tail = isMobile ? 0.7 : 1.05;
    const length = Math.ceil(sr * (spec.pre + spec.rt60 * tail));
    const buffer = ctx.createBuffer(2, length, sr);
    const preN = Math.floor(spec.pre * sr);
    const decayK = Math.log(1000) / spec.rt60;
    let rnd = seed >>> 0 || 1;
    const noise = () => {
      rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
      return ((rnd >>> 0) / 4294967296) * 2 - 1;
    };
    // Réflexions précoces : murs, piliers et voûte, différentes à gauche et à droite.
    const reflections = 18;
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = preN; i < length; i++) {
        const t = (i - preN) / sr;
        const life = Math.min(1, t / spec.rt60);
        const cutoff = spec.bright * Math.pow(spec.damp / spec.bright, life);
        const a = 1 - Math.exp(-2 * Math.PI * cutoff / sr);
        lp += (noise() - lp) * a;
        // La queue monte en 80 ms : la densité d'une nef met un temps à s'établir.
        const swell = t < 0.08 ? t / 0.08 : 1;
        data[i] = lp * Math.exp(-decayK * t) * swell * (1.2 + 1.8 * life);
      }
      for (let r = 0; r < reflections; r++) {
        const at = preN + Math.floor((0.004 + Math.pow(noise() * 0.5 + 0.5, 1.6) * 0.11) * sr);
        if (at >= length) continue;
        const amp = spec.early * Math.exp(-decayK * (at - preN) / sr) * (0.4 + 0.6 * Math.abs(noise()));
        data[at] += noise() < 0 ? -amp : amp;
      }
      let energy = 0;
      for (let i = 0; i < length; i++) energy += data[i] * data[i];
      const norm = 0.6 / Math.sqrt(energy || 1);
      for (let i = 0; i < length; i++) data[i] *= norm;
      seed += 7919;
      rnd = seed >>> 0 || 1;
    }
    return buffer;
  }

  function churchIR(ctx, id) {
    const key = id + "@" + ctx.sampleRate;
    if (!irCache[key]) irCache[key] = buildChurchIR(ctx, REVERBS[id], cyrb53(id));
    return irCache[key];
  }

  function applyReverb(ctx) {
    if (!ctx || ctx.state === "closed" || !ctx._gardenMaster) return;
    const t = ctx.currentTime;
    const prev = ctx._gardenVerb;
    const spec = REVERBS[reverbState.id];
    if (prev && prev.id === reverbState.id) {
      prev.wet.gain.cancelScheduledValues(t);
      prev.wet.gain.setTargetAtTime(reverbState.mix, t, 0.08);
      return;
    }
    if (prev) {
      prev.wet.gain.cancelScheduledValues(t);
      prev.wet.gain.setTargetAtTime(0, t, 0.12);
      setTimeout(() => {
        try { prev.send.disconnect(); prev.conv.disconnect(); prev.wet.disconnect(); } catch (_) { /* */ }
      }, 900);
      ctx._gardenVerb = null;
    }
    if (!spec) return;
    // Le grave est coupé avant la salle : sans ça, la contrebasse et les drones deviennent une bouillie.
    const send = ctx.createBiquadFilter();
    send.type = "highpass";
    send.frequency.value = spec.lowcut;
    send.Q.value = 0.6;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const verb = { id: reverbState.id, send, conv, wet };
    ctx._gardenVerb = verb;
    // L'IR se calcule après coup : jamais pendant le geste qui débloque l'audio sur iOS.
    setTimeout(() => {
      if (ctx._gardenVerb !== verb || ctx.state === "closed") return;
      try {
        conv.buffer = churchIR(ctx, verb.id);
        ctx._gardenMaster.connect(send);
        send.connect(conv);
        conv.connect(wet);
        wet.connect(ctx._gardenComp);
        wet.gain.setTargetAtTime(reverbState.mix, ctx.currentTime, 0.15);
      } catch (_) {
        ctx._gardenVerb = null;
      }
    }, 60);
  }

  function setReverb(id, mix) {
    reverbState.id = REVERBS[id] ? id : "";
    if (Number.isFinite(mix)) reverbState.mix = Math.max(0, Math.min(1, mix));
    if (sharedCtx) applyReverb(sharedCtx);
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
    ctx._gardenVerb = null;
    applyReverb(ctx);
    return master;
  }

  function wrapWorkletSource(src, processorName) {
    const escaped = processorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("registerProcessor\\(\\s*(['\"])" + escaped + "\\1\\s*,\\s*([^)]+)\\)");
    return src.replace(re, (_, quote, klass) => (
      "registerProcessor(" + quote + processorName + quote + ",(function(Base){" +
      "return class extends Base{" +
      "constructor(o){super(o);this._bad=0;this._told=0;this._pkAt=0;this._pk=0;this._mute=false;" +
      "this.port.addEventListener('message',e=>{if(e.data&&e.data.type==='set mute')this._mute=!!e.data.mute})}" +
      "process(i,o,p){" +
      "const ch=o&&o[0];if(!ch||!ch.length)return true;" +
      "if(this._mute){for(let c=0;c<ch.length;c++)ch[c].fill(0);return true}" +
      "let ok=true;" +
      "try{ok=super.process(i,o,p)}" +
      "catch(e){" +
      "for(let c=0;c<ch.length;c++)ch[c].fill(0);" +
      "this._report('throw');return true}" +
      "let bad=false,peak=0;" +
      "for(let c=0;c<ch.length;c++){" +
      "const b=ch[c];" +
      "for(let n=0;n<b.length;n++){" +
      "let s=b[n];" +
      "if(s!==s||s===Infinity||s===-Infinity){b[n]=0;bad=true;continue}" +
      "const a=s<0?-s:s;if(a>peak)peak=a;" +
      "if(a>1.6)b[n]=s>0?1.6+(s-1.6)*0.08:-1.6+(s+1.6)*0.08" +
      "}}" +
      "if(peak>this._pk)this._pk=peak;" +
      "if(currentTime-this._pkAt>0.03){this._pkAt=currentTime;" +
      "try{this.port.postMessage({type:'peak',peak:this._pk})}catch(e){}this._pk=0}" +
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
      const wrapped = wrapWorkletSource(await cachedFetch(url, "txt"), processorName);
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

  let rateFix = null;

  function nudgeContext(ctx) {
    // iOS ajoute un état « interrupted » (appel, verrouillage) qui se relance comme « suspended ».
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    const pending = ctx.resume();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  }

  function makeContext(rate) {
    const Ctor = global.AudioContext || global.webkitAudioContext;
    try {
      return new Ctor({ sampleRate: rate, latencyHint: "interactive" });
    } catch (_) {
      return new Ctor();
    }
  }

  function getSharedContext(wantRate) {
    if (sharedCtx && sharedCtx.state !== "closed") return sharedCtx;
    sharedCtx = makeContext(wantRate || 44100);
    setupMaster(sharedCtx);
    return sharedCtx;
  }

  // À appeler dans un geste (touchend, click) : iOS ne laisse démarrer le son que là.
  // Le patch se charge ensuite par import() puis compilation wasm, bien après la fin du geste,
  // donc le contexte doit exister et tourner avant.
  function unlock() {
    const nav = global.navigator;
    try {
      // Sans ça, le bouton silencieux de l'iPhone coupe tout le Web Audio.
      if (nav && nav.audioSession && nav.audioSession.type !== "playback") nav.audioSession.type = "playback";
    } catch (_) { /* Safari < 16.4 */ }
    const ctx = getSharedContext(44100);
    nudgeContext(ctx);
    if (ctx._gardenPrimed) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
      ctx._gardenPrimed = true;
    } catch (_) { /* contexte pas prêt */ }
  }

  async function recreateSharedContext(wantRate) {
    const old = sharedCtx;
    sharedScriptProc = null;
    sharedCtx = makeContext(wantRate || (old && old.sampleRate) || 44100);
    setupMaster(sharedCtx);
    if (old && old.state !== "closed") {
      try { await old.close(); } catch (_) { /* déjà fermé */ }
    }
    return sharedCtx;
  }

  function contextAt(wantRate) {
    if (sharedCtx && sharedCtx.state !== "closed" && sharedCtx.sampleRate === wantRate) {
      return Promise.resolve(sharedCtx);
    }
    if (!rateFix) {
      const job = (async () => {
        if (sharedCtx && sharedCtx.state !== "closed" && sharedCtx.sampleRate === wantRate) return sharedCtx;
        if (sharedCtx && sharedCtx.state !== "closed" && Object.keys(slots).length > 0) return sharedCtx;
        if (sharedCtx && sharedCtx.state !== "closed") return recreateSharedContext(wantRate);
        return getSharedContext(wantRate);
      })();
      rateFix = job.finally(() => { rateFix = null; });
    }
    return rateFix;
  }

  function wireWorkletGraph(audioContext, node) {
    const duck = audioContext.createGain();
    duck.gain.value = 1;
    // Porte rythmique : reste à 1 hors mode rythmé.
    const gate = audioContext.createGain();
    gate.gain.value = 1;
    const gain = audioContext.createGain();
    gain.gain.value = 0.0001;
    node.connect(duck);
    duck.connect(gate);
    gate.connect(gain);
    gain.connect(setupMaster(audioContext));
    return { duck, gate, gain };
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
      const d = event.data;
      if (!d) return;
      if (d.type === "dsp fault") markBroken(patch, d.why || "nan");
      else if (d.type === "peak") patch.rawPeak = d.peak;
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

  function tickSlotSlew(patch, dt) {
    if (!patch || !patch.paramTargets) return;
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

  function ensureSlewLoop() {
    if (!canUseWorklet()) return;
    if (slewTimer != null) return;
    const step = () => {
      slewTimer = null;
      if (!Object.keys(slots).length) return;
      tickParamSlew();
      slewTimer = (global.setTimeout || setTimeout)(step, 24);
    };
    slewTimer = (global.setTimeout || setTimeout)(step, 24);
  }

  function tickParamSlew() {
    const ctx = sharedCtx;
    if (!ctx || ctx.state === "closed") return;
    const now = ctx.currentTime;
    for (const slot of Object.keys(slots)) {
      const patch = slots[slot];
      if (!patch || patch.mode === "script") continue;
      const dt = Math.min(0.06, Math.max(0.008, now - (patch.slewAt || now)));
      patch.slewAt = now;
      tickSlotSlew(patch, dt);
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
      engine: null,
      params: {},
      lastParams: {},
      paramTargets: {},
      lastGain: 0.0001,
      curGain: 0.0001,
      duckGain: 1,
      rawPeak: 0,
      audiblePeak: 0,
      mode,
      muted: false,
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
      await addWorkletModule(audioContext, workletRoot + processorName + ".js?v=swell2", processorName);
      const node = new AudioWorkletNode(audioContext, processorName, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const graph = wireWorkletGraph(audioContext, node);
      patch.node = node;
      patch.gain = graph.gain;
      patch.duck = graph.duck;
      patch.gate = graph.gate;
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
      try { patch.node && patch.node.disconnect(); } catch (_) { /* */ }
      try { patch.duck && patch.duck.disconnect(); } catch (_) { /* */ }
      try { patch.gain && patch.gain.disconnect(); } catch (_) { /* */ }
      ctx = await contextAt(result.wantRate);
      if (!ctx || ctx.sampleRate !== result.wantRate) {
        throw new Error("Faust worklet: " + result.type);
      }
      result = await attach(ctx);
    }
    if (result.type !== "main ready") {
      try { patch.node && patch.node.disconnect(); } catch (_) { /* */ }
      try { patch.gain && patch.gain.disconnect(); } catch (_) { /* */ }
      try { patch.duck && patch.duck.disconnect(); } catch (_) { /* */ }
      throw new Error("Faust worklet: " + (result.type || "échec"));
    }
    nudgeContext(ctx);
    patch.startedAt = (global.performance && performance.now()) || Date.now();
    ensureSlewLoop();
    return patch;
  }

  // Porte rythmique : attaque de 6 ms puis retombée vers le plancher sur la durée du pas.
  const GATE_ATTACK = 0.006;

  function gateAt(patch, t, dt) {
    const list = patch.pulses;
    while (list.length > 1 && list[1].t <= t) list.shift();
    const p = list[0];
    let target = 1;
    let tau = 0.05;
    if (p && p.t <= t) {
      if (t - p.t < GATE_ATTACK) { target = 1; tau = 0.002; }
      else { target = p.floor; tau = Math.max(0.01, p.decay / 3); }
    } else if (p) {
      target = patch.gateVal ?? 1;
    }
    const v = patch.gateVal ?? 1;
    patch.gateVal = v + (target - v) * (1 - Math.exp(-dt / tau));
    return patch.gateVal;
  }

  // Programme un coup de porte à l'heure `t` du contexte audio.
  function pulse(slot, t, floor, decay) {
    const patch = typeof slot === "string" ? slots[slot] : slot;
    if (!patch || !patch.ctx || patch.ctx.state === "closed") return;
    const fl = Math.max(0, Math.min(1, floor));
    const dk = Math.max(0.02, decay);
    if (patch.mode === "script") {
      patch.pulses = patch.pulses || [];
      patch.pulses.push({ t, floor: fl, decay: dk });
      return;
    }
    if (!patch.gate) return;
    const g = patch.gate.gain;
    g.setTargetAtTime(1, t, GATE_ATTACK / 3);
    g.setTargetAtTime(Math.max(fl, 0.0001), t + GATE_ATTACK, dk / 3);
  }

  // Sortie du mode rythmé : la porte se rouvre en douceur.
  function clearGate(slot) {
    const patch = typeof slot === "string" ? slots[slot] : slot;
    if (!patch) return;
    patch.pulses = null;
    patch.gateVal = 1;
    if (patch.gate && patch.ctx && patch.ctx.state !== "closed") {
      const g = patch.gate.gain;
      const now = patch.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(1, now, 0.08);
    }
  }

  function ensureSharedScriptMixer(ctx) {
    if (sharedScriptProc && sharedScriptProc._ctx === ctx) return sharedScriptProc;
    const bufSize = isMobile ? 4096 : 2048;
    const proc = ctx.createScriptProcessor(bufSize, 0, 2);
    proc._ctx = ctx;
    const dt = bufSize / ctx.sampleRate;
    proc.onaudioprocess = (ev) => {
      const left = ev.outputBuffer.getChannelData(0);
      const right = ev.outputBuffer.getChannelData(1);
      left.fill(0);
      right.fill(0);
      const slotNames = Object.keys(slots);
      for (let s = 0; s < slotNames.length; s++) {
        const patch = slots[slotNames[s]];
        if (!patch || patch.mode !== "script" || !patch.engine || patch.broken) continue;
        const tgtGain = (patch.lastGain || 0) * (patch.duckGain || 1);
        const curGain = patch.curGain ?? tgtGain;
        const nextGain = curGain + (tgtGain - curGain) * Math.min(1, dt / 0.05);
        patch.curGain = nextGain;
        if (tgtGain < 0.00025 && nextGain < 0.00025) {
          patch.rawPeak = 0;
          patch.audiblePeak = 0;
          continue;
        }
        tickSlotSlew(patch, dt);
        try {
          if (patch.engine.fillAdd && patch.pulses) {
            // Mode rythmé : la porte se calcule par blocs de 128 à l'heure de lecture du tampon.
            const t0 = ev.playbackTime != null ? ev.playbackTime : ctx.currentTime;
            const n = left.length;
            let peak = 0;
            let bad = 0;
            for (let at = 0; at < n; at += 128) {
              const end = Math.min(n, at + 128);
              const g0 = gateAt(patch, t0 + at / ctx.sampleRate, 128 / ctx.sampleRate);
              const a = curGain + (nextGain - curGain) * (at / n);
              const b = curGain + (nextGain - curGain) * (end / n);
              const stats = patch.engine.fillAdd(left.subarray(at, end), right.subarray(at, end), a * g0, b * g0);
              if (stats.peak > peak) peak = stats.peak;
              bad += stats.bad;
            }
            const avgGain = Math.max(0.0001, (curGain + nextGain) * 0.5);
            patch.audiblePeak = peak;
            patch.rawPeak = peak / avgGain;
            if (bad > 32) markBroken(patch, "nan");
          } else if (patch.engine.fillAdd) {
            const stats = patch.engine.fillAdd(left, right, curGain, nextGain);
            const avgGain = Math.max(0.0001, (curGain + nextGain) * 0.5);
            patch.audiblePeak = stats.peak;
            patch.rawPeak = stats.peak / avgGain;
            if (stats.bad > 32) markBroken(patch, "nan");
          } else {
            patch.engine.fill(left, right);
          }
        } catch (_) {
          markBroken(patch, "error");
        }
      }
    };
    proc.connect(setupMaster(ctx));
    sharedScriptProc = proc;
    return proc;
  }

  async function startScript(name, kind) {
    const callbacks = compileCallbacks(name);
    const url = rootFor(name) + "patch.js?v=swell2";
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
    ensureSharedScriptMixer(ctx);
    const patch = blankPatch(name, kind, ctx, "script");
    patch.engine = engine;
    patch.params = engine.params || {};
    patch.setParamFn = engine.setParam;
    nudgeContext(ctx);
    patch.startedAt = (global.performance && performance.now()) || Date.now();
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
    if (patch.mode === "script") {
      patch.engine = null;
      return;
    }
    try {
      if (patch.gain && patch.ctx && patch.ctx.state !== "closed") {
        const t = patch.ctx.currentTime;
        patch.gain.gain.cancelScheduledValues(t);
        patch.gain.gain.setTargetAtTime(0.0001, t, 0.02);
      }
    } catch (_) { /* déjà fermé */ }
    await new Promise((r) => setTimeout(r, 35));
    try { patch.node && patch.node.disconnect(); } catch (_) { /* déjà déconnecté */ }
    try { patch.duck && patch.duck.disconnect(); } catch (_) { /* */ }
    try { patch.gate && patch.gate.disconnect(); } catch (_) { /* */ }
    try { patch.gain && patch.gain.disconnect(); } catch (_) { /* déjà déconnecté */ }
  }

  async function stopSlot(slot) {
    const patch = slots[slot];
    if (!patch) return;
    delete slots[slot];
    await disposePatch(patch);
  }

  async function startSlot(slot, kind, initParams) {
    if (slots[slot] && slots[slot].kind === kind && !slots[slot].broken) {
      nudgeContext(slots[slot].ctx);
      return slots[slot];
    }
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
    const prev = slotChains[slot] || Promise.resolve();
    const task = prev.then(() => startSlot(slot, kind, initParams));
    slotChains[slot] = task.catch(() => {});
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
    if (!patch || !patch.ctx || patch.ctx.state === "closed") return;
    const next = Math.max(val, 0.0001);
    const prev = patch.lastGain || 0;
    const scale = Math.max(prev, next, 0.0001);
    if (Math.abs(prev - next) < Math.max(0.00008, scale * 0.035)) return;
    patch.lastGain = next;
    if (patch.mode === "script") return;
    if (!patch.gain) return;
    const shouldMute = next < 0.00025;
    if (shouldMute !== patch.muted && patch.node && patch.node.port) {
      patch.muted = shouldMute;
      try { patch.node.port.postMessage({ type: "set mute", mute: shouldMute }); } catch (_) { /* */ }
    }
    try {
      const t = now ?? patch.ctx.currentTime;
      const g = patch.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.setTargetAtTime(next, t, 0.02);
    } catch (_) { /* contexte fermé */ }
  }

  function applyDuck(patch, amount) {
    if (!patch || !patch.ctx || patch.ctx.state === "closed") return;
    const next = Math.max(0.05, Math.min(1, amount));
    if (Math.abs((patch.duckGain || 1) - next) < 0.02) return;
    patch.duckGain = next;
    if (patch.mode === "script" || !patch.duck) return;
    try {
      const t = patch.ctx.currentTime;
      patch.duck.gain.cancelScheduledValues(t);
      patch.duck.gain.setTargetAtTime(next, t, 0.05);
    } catch (_) { /* */ }
  }

  function readPeak(patch) {
    if (!patch) return 0;
    if (patch.mode === "script") return patch.audiblePeak || 0;
    return (patch.rawPeak || 0) * (patch.lastGain || 0) * (patch.duckGain || 1);
  }

  function readFaultPeak(patch) {
    if (!patch) return 0;
    return patch.rawPeak || 0;
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
      if (sharedScriptProc) {
        try { sharedScriptProc.onaudioprocess = null; sharedScriptProc.disconnect(); } catch (_) { /* */ }
        sharedScriptProc = null;
      }
      try { await sharedCtx.close(); } catch (_) { /* déjà fermé */ }
      sharedCtx = null;
    }
  }

  async function prefetch(kinds) {
    const list = kinds && kinds.length ? kinds : Object.keys(PATCHES);
    await Promise.all(list.map(async (kind) => {
      const name = PATCHES[kind] || kind;
      if (!name) return;
      const cbs = compileCallbacks(name);
      const files = DSP_FILES[name] || [];
      await Promise.all(files.map(async (file) => {
        const code = await cbs.fetchMainRelative(file);
        await cbs.compileFaust(code);
      }));
      if (canUseWorklet()) {
        await cachedFetch(rootFor(name) + "worklet_" + name + ".js?v=swell2", "txt");
      } else {
        await import(rootFor(name) + "patch.js?v=swell2");
      }
    }));
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
    REVERBS,
    setReverb,
    unlock,
    pulse,
    clearGate,
    // Bus partagé pour les voix jouées hors Faust (quantizer) : même compresseur, même réverbe.
    bus() {
      const ctx = getSharedContext(44100);
      return { ctx, master: setupMaster(ctx) };
    },
    get current() { return slots.ambiance || Object.values(slots)[0] || null; },
    get slots() { return slots; },
  };
})(window);
