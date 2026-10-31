/**
 * Mode quantizer : un seul instrument d'Ambient Garden, calé sur le BPM.
 * Par défaut une note par temps ; plus le signal de la plante s'agite, plus la
 * subdivision se resserre (1/8, 1/16, 1/32), ou en triolets en mode ternaire.
 * La hauteur suit la position filtrée de la plante, ramenée sur une gamme.
 */
(function (global) {
  "use strict";

  // 24 pas par temps : tombe juste pour les croches, doubles, triples et tous les triolets.
  const PPQ = 24;
  const MULT = {
    binary: [1, 2, 4, 8],
    ternary: [1, 3, 6, 12],
  };
  const LABELS = {
    binary: ["1/4", "1/8", "1/16", "1/32"],
    ternary: ["1/4", "1/8T", "1/16T", "1/32T"],
  };

  const SCALES = {
    "penta-min": { label: "Penta mineure", steps: [0, 3, 5, 7, 10] },
    "penta-maj": { label: "Penta majeure", steps: [0, 2, 4, 7, 9] },
    dorien: { label: "Dorien", steps: [0, 2, 3, 5, 7, 9, 10] },
    hirajoshi: { label: "Hirajōshi", steps: [0, 2, 3, 7, 8] },
  };

  const NOTE_NAMES = ["Do", "Do♯", "Ré", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "La♭", "La", "Si♭", "Si"];

  // Les instruments d'Ambient Garden qui se jouent note à note : un excitateur bref
  // (souffle de bruit) frappe un corps modal ou une corde, puis toutes les voix passent
  // dans le post.dsp du patch (delays, phaser, réverbe zita, limiteur), comme dans
  // Ambient Garden. Seul le déclenchement passe sur la grille.
  // gain : mesuré sur le DSP réel pour amener chaque instrument au même niveau moyen.
  const BLOCK = 128;
  const TIMBRES = {
    carillon: {
      label: "Carillon", patch: "wind-chimes", dsp: "faust/chime.dsp", post: { preamp: 1, lp1: 600, hp1: 500 }, oct: 12, range: [80, 2500], voices: 8, gain: 1.4,
      strike(v, amp) { v.pos = 0; v.amp = amp; },
      ctrl(v, dt) { v.pos += dt; v.p.noise = Math.max(0, 1.2 / (v.pos * 10 + 1) - 0.2) * v.amp; },
    },
    cloches: {
      label: "Cloches", patch: "wind-bells", dsp: "faust/chime.dsp", post: { preamp: 1, lp1: 600, hp1: 500 }, oct: 0, range: [80, 2500], voices: 8, gain: 2.1,
      strike(v, amp) { v.pos = 0; v.amp = amp; },
      ctrl(v, dt) { v.pos += dt; v.p.noise = Math.max(0, 1.2 / (v.pos * 10 + 1) - 0.2) * v.amp; },
    },
    vibraphone: {
      label: "Vibraphone", patch: "vibraphones", dsp: "faust/vib.dsp", post: { preamp: 1 }, oct: 0, range: [50, 1800], voices: 6, gain: 1.65,
      init: { lp1: 2400 },
      strike(v, amp) { v.p.noise = amp; },
      ctrl(v) { v.p.noise *= 0.7; },
    },
    cordes: {
      label: "Cordes", patch: "moon-strings", dsp: "faust/pluck.dsp", post: { preamp: 1, delfb: 0.5 }, oct: 0, range: [50, 4000], voices: 6, gain: 2.4,
      init: { lp1: 3000, fb: 0.96 },
      strike(v, amp) { v.pos = 0; v.amp = amp; },
      ctrl(v, dt) {
        v.pos += dt;
        const h = 0.007;
        const e = v.pos < h ? (v.pos / h) * (v.pos / h) : Math.max(0, 1.5 / ((v.pos - h) * 300 + 1) - 0.5);
        v.p.noise = e * v.amp;
      },
    },
    eau: {
      label: "Cloche d’eau", patch: "water-bell", dsp: "faust/modal.dsp", post: { preamp: 1 }, oct: 0, range: [50, 1800], voices: 4, gain: 1.25,
      init: { lp1: 400, mode0: 0, mode1: 0, mode2: 0, mode3: 0, mode4: 0 },
      strike(v, amp) {
        for (let n = 0; n < 5; n++) {
          let m = amp * (n + 1) / 5;
          if (n < v.freq / 150) m *= 0.3;
          v.p["mode" + n] = Math.max(v.p["mode" + n] || 0, m);
        }
      },
      ctrl(v) { for (let n = 0; n < 5; n++) v.p["mode" + n] *= 0.99; },
    },
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

  function wasmImports(memory) {
    const M = Math;
    const env = { memory, memoryBase: 0, tableBase: 0, table: new WebAssembly.Table({ initial: 0, element: "anyfunc" }) };
    const fns = {
      abs: M.abs, acos: M.acos, asin: M.asin, atan: M.atan, atan2: M.atan2, ceil: M.ceil, cos: M.cos, exp: M.exp,
      floor: M.floor, fmod: (a, b) => a % b, log: M.log, log10: M.log10, max_: M.max, min_: M.min,
      remainder: (a, b) => a - M.round(a / b) * b, pow: M.pow, round: M.fround, sin: M.sin, sqrt: M.sqrt, tan: M.tan,
      acosh: M.acosh, asinh: M.asinh, atanh: M.atanh, cosh: M.cosh, sinh: M.sinh, tanh: M.tanh,
    };
    for (const k of Object.keys(fns)) {
      env["_" + k] = fns[k];
      env["_" + (k.endsWith("_") ? k.slice(0, -1) + "_f" : k + "f")] = fns[k];
    }
    env._abs = M.abs;
    return { env };
  }

  function paramIndex(meta) {
    const out = {};
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.items) walk(node.items);
      if (node.address && node.label != null && node.index != null) out[node.label] = node.index;
    };
    walk(meta.ui);
    return out;
  }

  // N instances d'un même DSP dans une mémoire wasm, comme le fait l'hôte d'Ambient Garden.
  async function instantiate(wasmBytes, meta, count, sampleRate) {
    const nIn = meta.inputs;
    const nOut = meta.outputs;
    const io = (nIn + nOut) * 4 + (nIn + nOut) * BLOCK * 4 + 64;
    const bytes = (meta.size + io) * count + 1024;
    const pages = Math.max(1, Math.ceil(bytes / 65536));
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const mod = await WebAssembly.compile(wasmBytes);
    const inst = await WebAssembly.instantiate(mod, wasmImports(memory));
    const fx = inst.exports;
    const i32 = new Int32Array(memory.buffer);
    const f32 = new Float32Array(memory.buffer);
    const align = (x) => (x + 3) & ~3;
    let ofs = 0;
    const list = [];
    for (let k = 0; k < count; k++) {
      ofs = align(ofs);
      const dsp = ofs;
      ofs = align(ofs + meta.size);
      const inPtrs = ofs;
      ofs += nIn * 4;
      const outPtrs = ofs;
      ofs += nOut * 4;
      const ins = [];
      for (let c = 0; c < nIn; c++) {
        i32[inPtrs / 4 + c] = ofs;
        ins.push(f32.subarray(ofs / 4, ofs / 4 + BLOCK));
        ofs += BLOCK * 4;
      }
      const outs = [];
      for (let c = 0; c < nOut; c++) {
        i32[outPtrs / 4 + c] = ofs;
        outs.push(f32.subarray(ofs / 4, ofs / 4 + BLOCK));
        ofs += BLOCK * 4;
      }
      fx.init(dsp, sampleRate);
      list.push({ dsp, inPtrs, outPtrs, ins, outs, sent: {} });
    }
    const idx = paramIndex(meta);
    const set = (unit, params) => {
      for (const name in params) {
        const val = params[name];
        if (idx[name] == null || unit.sent[name] === val) continue;
        fx.setParamValue(unit.dsp, idx[name], val);
        unit.sent[name] = val;
      }
    };
    return { fx, list, set };
  }

  // Un hôte = les voix de l'instrument + la chaîne post du patch, rendues bloc par bloc.
  async function createHost(def, sampleRate, wasmBytes, meta, postBytes, postMeta) {
    const body = await instantiate(wasmBytes, meta, def.voices, sampleRate);
    const post = postBytes ? await instantiate(postBytes, postMeta, 1, sampleRate) : null;
    const fx = body.fx;
    const voices = body.list.map((u) => Object.assign(u, {
      out: u.outs[0], p: Object.assign({ freq: 400, noise: 0 }, def.init || {}), pos: 100, amp: 0, freq: 400, pan: 0, used: 0, idle: 999,
    }));
    voices.forEach((v) => body.set(v, v.p));
    const bus = post ? post.list[0] : null;
    if (bus) post.set(bus, def.post || {});
    const mono = new Float32Array(BLOCK);
    let tail = 0;
    let clock = 0;
    return {
      def,
      voices,
      strike(freq, amp, pan) {
        // La voix la plus anciennement frappée prend la note.
        let v = voices[0];
        for (const w of voices) if (w.used < v.used) v = w;
        clock++;
        v.used = clock;
        v.freq = Math.max(def.range[0], Math.min(def.range[1], freq));
        v.p.freq = v.freq;
        v.pan = pan;
        v.idle = 0;
        tail = 0;
        def.strike(v, amp);
      },
      // Ajoute un bloc de 128 échantillons dans L/R à partir de l'index `at`.
      render(L, R, at, gain) {
        const dt = BLOCK / sampleRate;
        mono.fill(0);
        let live = false;
        for (const v of voices) {
          if (v.idle > 400) continue;
          live = true;
          def.ctrl(v, dt);
          body.set(v, v.p);
          fx.compute(v.dsp, BLOCK, v.inPtrs, v.outPtrs);
          const out = v.out;
          let peak = 0;
          for (let i = 0; i < BLOCK; i++) {
            let s = out[i];
            if (s !== s) s = 0;
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            mono[i] += s;
          }
          // Voix éteinte : on arrête de la calculer jusqu'à la prochaine frappe.
          v.idle = peak < 2e-5 ? v.idle + 1 : 0;
        }
        if (!bus) {
          for (let i = 0; i < BLOCK; i++) { L[at + i] += mono[i] * gain; R[at + i] += mono[i] * gain; }
          return;
        }
        // La réverbe et les delays du patch continuent de sonner après la dernière voix (~12 s).
        if (!live) {
          tail++;
          if (tail > 12 * sampleRate / BLOCK) return;
        }
        bus.ins[0].set(mono);
        post.fx.compute(bus.dsp, BLOCK, bus.inPtrs, bus.outPtrs);
        const pl = bus.outs[0];
        const pr = bus.outs[1] || pl;
        for (let i = 0; i < BLOCK; i++) {
          const l = pl[i];
          const r = pr[i];
          L[at + i] += (l === l ? l : 0) * gain;
          R[at + i] += (r === r ? r : 0) * gain;
        }
      },
    };
  }

  const hostCache = {};
  // Chaque propriétaire (quantizer, piste) a ses propres voix : un hôte ne se partage pas.
  async function loadHost(id, sampleRate, owner) {
    const def = TIMBRES[id];
    const key = (owner || "") + ":" + id + "@" + sampleRate;
    if (hostCache[key]) return hostCache[key];
    const root = "/faust/" + def.patch + "/";
    const injected = (global.FAUST_DSP_HASHES || {})[def.patch] || {};
    const hashOf = async (path) => {
      if (injected[path] != null) return injected[path];
      return cyrb53(await (await fetch(root + path)).text());
    };
    const load = async (path) => {
      const hash = await hashOf(path);
      return Promise.all([
        fetch(root + hash + ".wasm").then((r) => r.arrayBuffer()),
        fetch(root + hash + ".json").then((r) => r.json()),
      ]);
    };
    hostCache[key] = Promise.all([load(def.dsp), load("faust/post.dsp")])
      .then(([[bytes, meta], [pBytes, pMeta]]) => createHost(def, sampleRate, bytes, meta, pBytes, pMeta));
    hostCache[key].catch(() => { delete hostCache[key]; });
    return hostCache[key];
  }

  // Croche, croche pointée, noire, noire pointée, blanche.
  const DELAY_BEATS = [0.5, 0.75, 1, 1.5, 2];

  const DEFAULTS = {
    every: 1,
    ternary: false,
    cap: 3,
    timbre: "carillon",
    scale: "penta-min",
    root: 9,
    level: 70,
    octave: 0,
    // Les pistes Faust continuent de jouer sous le quantizer.
    withTracks: false,
    // Delay calé sur le BPM : durée en temps, retour et niveau en %.
    delayOn: false,
    delayBeats: 0.75,
    delayFb: 45,
    delayMix: 40,
    // Seuils d'agitation (0–1) qui font passer au niveau suivant.
    thresholds: [0.22, 0.46, 0.72],
  };

  function sanitize(o) {
    const src = o && typeof o === "object" ? o : {};
    const out = Object.assign({}, DEFAULTS, { thresholds: DEFAULTS.thresholds.slice() });
    if ([1, 2, 3, 4, 8].indexOf(src.every) !== -1) out.every = src.every;
    if (typeof src.ternary === "boolean") out.ternary = src.ternary;
    if (Number.isFinite(src.cap)) out.cap = Math.max(1, Math.min(3, Math.round(src.cap)));
    if (TIMBRES[src.timbre]) out.timbre = src.timbre;
    if (SCALES[src.scale]) out.scale = src.scale;
    if (Number.isFinite(src.root)) out.root = ((Math.round(src.root) % 12) + 12) % 12;
    if (Number.isFinite(src.level)) out.level = Math.max(0, Math.min(100, src.level));
    if (Number.isFinite(src.octave)) out.octave = Math.max(-2, Math.min(2, Math.round(src.octave)));
    if (typeof src.withTracks === "boolean") out.withTracks = src.withTracks;
    if (typeof src.delayOn === "boolean") out.delayOn = src.delayOn;
    if (DELAY_BEATS.indexOf(src.delayBeats) !== -1) out.delayBeats = src.delayBeats;
    if (Number.isFinite(src.delayFb)) out.delayFb = Math.max(0, Math.min(90, src.delayFb));
    if (Number.isFinite(src.delayMix)) out.delayMix = Math.max(0, Math.min(100, src.delayMix));
    if (Array.isArray(src.thresholds) && src.thresholds.length === 3 && src.thresholds.every(Number.isFinite)) {
      out.thresholds = src.thresholds.map((v) => Math.max(0.02, Math.min(0.98, v))).sort((a, b) => a - b);
    }
    return out;
  }

  // ─── Horloge commune ───
  // Une seule grille pour tout le monde : le quantizer et les pistes rythmées
  // tombent sur les mêmes temps. Chaque « voie » a ses seuils, son pas et son plafond.
  const clock = {
    ctx: null,
    timer: 0,
    tick: 0,
    nextTime: 0,
    getBpm: () => 60,
    getBus: null,
    lanes: new Map(),
  };

  function laneMode(o) {
    return o.ternary ? "ternary" : "binary";
  }

  // Hystérésis : on monte au seuil, on ne redescend que 6 points plus bas.
  function levelFor(o, v, cur) {
    const th = o.thresholds;
    let lvl = 0;
    for (let i = 0; i < th.length; i++) if (v >= th[i]) lvl = i + 1;
    if (lvl < cur && cur > 0 && v > th[cur - 1] - 0.06) lvl = cur;
    return Math.min(lvl, o.cap);
  }

  function stepTicks(o, lvl) {
    return Math.round((PPQ * o.every) / MULT[laneMode(o)][lvl]);
  }

  function snapFreq(o, f) {
    const sc = SCALES[o.scale].steps;
    const midi = 69 + 12 * Math.log2(Math.max(f, 20) / 440);
    let best = midi;
    let dist = Infinity;
    const base = Math.floor((midi - o.root) / 12) * 12 + o.root;
    for (let k = -12; k <= 12; k += 12) {
      for (const step of sc) {
        const m = base + k + step;
        if (Math.abs(m - midi) < dist) { dist = Math.abs(m - midi); best = m; }
      }
    }
    return { freq: 440 * Math.pow(2, (best - 69) / 12), midi: best, deg: best };
  }

  function noteFor(o, lane, t01) {
    const sc = SCALES[o.scale].steps;
    const span = sc.length * 2 + 1;
    let deg = Math.max(0, Math.min(span - 1, Math.round(t01 * (span - 1))));
    // Un robot évite de bégayer : même degré deux fois de suite, il glisse d'un cran.
    if (deg === lane.lastDegree && clock.tick % (PPQ * 2) !== 0) deg = deg < span - 1 ? deg + 1 : deg - 1;
    lane.lastDegree = deg;
    const oct = Math.floor(deg / sc.length);
    const semi = sc[deg % sc.length] + 12 * oct;
    const midi = 48 + o.root + semi;
    return { freq: 440 * Math.pow(2, (midi - 69) / 12), midi, deg };
  }

  // Moteur de rendu d'une voie : un ScriptProcessor tire la file de notes et fait jouer
  // l'hôte Faust. Il marche partout, y compris en HTTP sur le Pico, sans AudioWorklet.
  function makeEngine(owner, ctx, dest) {
    const eng = { owner, ctx, host: null, want: "", queue: [], octave: 0, out: ctx.createGain(), proc: null };
    eng.out.gain.value = 0.9;
    eng.out.connect(dest);
    // Delay en boucle après le volume : chaque retour passe par un passe-bas et un passe-haut,
    // les répétitions s'assombrissent et ne s'empâtent pas dans le grave.
    eng.send = ctx.createGain();
    eng.send.gain.value = 0;
    eng.delay = ctx.createDelay(7);
    eng.delay.delayTime.value = 0.75;
    eng.dlp = ctx.createBiquadFilter();
    eng.dlp.type = "lowpass";
    eng.dlp.frequency.value = 3400;
    eng.dhp = ctx.createBiquadFilter();
    eng.dhp.type = "highpass";
    eng.dhp.frequency.value = 160;
    eng.fb = ctx.createGain();
    eng.fb.gain.value = 0.45;
    eng.wet = ctx.createGain();
    eng.wet.gain.value = 0;
    eng.out.connect(eng.send);
    eng.send.connect(eng.delay);
    eng.delay.connect(eng.dlp);
    eng.dlp.connect(eng.dhp);
    eng.dhp.connect(eng.fb);
    eng.fb.connect(eng.delay);
    eng.dhp.connect(eng.wet);
    eng.wet.connect(dest);
    const size = /Android|iPhone|iPad|iPod/i.test((global.navigator && global.navigator.userAgent) || "") ? 2048 : 1024;
    const proc = ctx.createScriptProcessor(size, 0, 2);
    proc.onaudioprocess = (ev) => {
      const L = ev.outputBuffer.getChannelData(0);
      const R = ev.outputBuffer.getChannelData(1);
      L.fill(0);
      R.fill(0);
      const host = eng.host;
      if (!host) { eng.queue.length = 0; return; }
      const sr = ctx.sampleRate;
      const t0 = ev.playbackTime != null ? ev.playbackTime : ctx.currentTime;
      const gain = host.def.gain * 0.9;
      for (let at = 0; at + BLOCK <= L.length; at += BLOCK) {
        const tEnd = t0 + (at + BLOCK) / sr;
        while (eng.queue.length && eng.queue[0].time < tEnd) {
          const n = eng.queue.shift();
          host.strike(n.freq * Math.pow(2, (n.raw ? 0 : host.def.oct / 12) + eng.octave), n.amp, n.pan);
        }
        host.render(L, R, at, gain);
      }
    };
    proc.connect(eng.out);
    eng.proc = proc;
    eng.use = async (id) => {
      const want = TIMBRES[id] ? id : DEFAULTS.timbre;
      if (eng.want === want && eng.host) return;
      eng.want = want;
      try {
        const host = await loadHost(want, ctx.sampleRate, owner);
        if (eng.want === want) eng.host = host;
      } catch (err) {
        if (global.console) console.warn("Instrument indisponible", want, err);
      }
    };
    eng.dispose = () => {
      try { proc.onaudioprocess = null; proc.disconnect(); eng.out.disconnect(); } catch (_) { /* */ }
      for (const n of [eng.send, eng.delay, eng.dlp, eng.dhp, eng.fb, eng.wet]) {
        try { n.disconnect(); } catch (_) { /* */ }
      }
    };
    return eng;
  }

  function emit(lane, info) {
    if (!lane.listeners.length || !clock.ctx) return;
    const delay = Math.max(0, (info.at - clock.ctx.currentTime) * 1000);
    setTimeout(() => {
      for (let i = 0; i < lane.listeners.length; i++) {
        try { lane.listeners[i](info); } catch (_) { /* */ }
      }
    }, delay);
  }

  function stepLane(lane, tickDur) {
    const o = lane.getOpts();
    if (!o) return;
    // Le niveau ne change que sur un temps : l'accélération reste sur la grille.
    if (clock.tick % PPQ === 0) lane.lvl = levelFor(o, Math.max(0, Math.min(1, lane.getVariation())), lane.lvl);
    const steps = stepTicks(o, lane.lvl);
    if (clock.tick % steps !== 0) return;
    const onBeat = clock.tick % PPQ === 0;
    const gate = Math.max(0, Math.min(1, lane.getGate()));
    const accent = onBeat ? 1 : 0.72;
    const info = {
      lane: lane.id,
      at: clock.nextTime,
      level: lane.lvl,
      label: LABELS[laneMode(o)][lane.lvl],
      onBeat,
      accent,
      gate,
      stepDur: steps * tickDur,
      beat: Math.floor(clock.tick / PPQ),
      step: Math.floor((clock.tick % (PPQ * o.every)) / steps),
      stepsPerCycle: Math.round((PPQ * o.every) / steps),
    };
    if (lane.engine) {
      // Le volume se règle en sortie (getLevelGain) : la chaîne d'effets du patch finit par un
      // limiteur qui écraserait un volume appliqué à la frappe. Ici, seulement l'accent.
      const vel = accent * gate;
      if (vel <= 0.001) return;
      const hz = lane.getFreq ? lane.getFreq() : null;
      const n = Number.isFinite(hz) && hz > 0 ? snapFreq(o, hz) : noteFor(o, lane, Math.max(0, Math.min(1, lane.getPitch())));
      info.midi = n.midi;
      info.degree = n.deg;
      const pan = ((clock.tick / steps) % 2 ? 0.28 : -0.28) * (lane.lvl ? 1 : 0.3);
      lane.engine.octave = o.octave || 0;
      // Une hauteur venue du paramètre de la piste est déjà dans le registre du patch.
      lane.engine.queue.push({ time: clock.nextTime, freq: n.freq, amp: vel, pan, raw: Number.isFinite(hz) && hz > 0 });
    } else if (gate <= 0.001) {
      return;
    }
    if (lane.onStep) lane.onStep(info);
    emit(lane, info);
  }

  function schedule() {
    const ctx = clock.ctx;
    if (!ctx || ctx.state === "closed" || !clock.lanes.size) return;
    const bpm = Math.max(10, clock.getBpm());
    const tickDur = 60 / bpm / PPQ;
    const horizon = ctx.currentTime + 0.14;
    if (clock.nextTime < ctx.currentTime - 0.25) clock.nextTime = ctx.currentTime + 0.03;
    for (const lane of clock.lanes.values()) {
      const eng = lane.engine;
      if (!eng) continue;
      const now = ctx.currentTime;
      if (lane.getLevelGain) eng.out.gain.setTargetAtTime(Math.max(0, lane.getLevelGain()), now, 0.05);
      const o = lane.getOpts();
      if (o && o.delayOn != null) {
        const on = !!o.delayOn;
        eng.delay.delayTime.setTargetAtTime(Math.min(6.9, (o.delayBeats || 0.75) * 60 / bpm), now, 0.08);
        eng.fb.gain.setTargetAtTime((o.delayFb || 0) / 100, now, 0.05);
        eng.send.gain.setTargetAtTime(on ? 1 : 0, now, 0.05);
        eng.wet.gain.setTargetAtTime(on ? (o.delayMix || 0) / 100 : 0, now, 0.08);
      }
    }
    while (clock.nextTime < horizon) {
      for (const lane of clock.lanes.values()) stepLane(lane, tickDur);
      clock.tick = (clock.tick + 1) % (PPQ * 8 * 12);
      clock.nextTime += tickDur;
    }
  }

  function ensureClock() {
    const bus = clock.getBus && clock.getBus();
    if (!bus) return false;
    if (clock.ctx !== bus.ctx) {
      for (const lane of clock.lanes.values()) {
        if (lane.engine) { lane.engine.dispose(); lane.engine = null; }
      }
      clock.ctx = bus.ctx;
      clock.nextTime = 0;
    }
    clock.master = bus.master;
    if (!clock.timer) {
      clock.tick = 0;
      clock.nextTime = clock.ctx.currentTime + 0.06;
      clock.timer = setInterval(schedule, 25);
    }
    return true;
  }

  function stopClockIfIdle() {
    if (clock.lanes.size || !clock.timer) return;
    clearInterval(clock.timer);
    clock.timer = 0;
  }

  // Ajoute ou met à jour une voie. `timbre` (id d'instrument) = la voie joue des notes ;
  // sans timbre, elle ne fait que battre la grille via onStep.
  function setLane(id, cfg) {
    if (!ensureClock()) return false;
    let lane = clock.lanes.get(id);
    if (!lane) {
      lane = { id, lvl: 0, lastDegree: -1, listeners: [], engine: null };
      clock.lanes.set(id, lane);
    }
    Object.assign(lane, {
      getOpts: cfg.getOpts,
      getVariation: cfg.getVariation || (() => 0),
      getGate: cfg.getGate || (() => 1),
      getPitch: cfg.getPitch || (() => 0.5),
      getFreq: cfg.getFreq || null,
      getLevelGain: cfg.getLevelGain || null,
      onStep: cfg.onStep || null,
    });
    if (cfg.listener && lane.listeners.indexOf(cfg.listener) === -1) lane.listeners.push(cfg.listener);
    if (cfg.timbre) {
      if (!lane.engine) lane.engine = makeEngine(id, clock.ctx, clock.master);
      lane.engine.use(cfg.timbre);
    } else if (lane.engine) {
      lane.engine.dispose();
      lane.engine = null;
    }
    return true;
  }

  function removeLane(id) {
    const lane = clock.lanes.get(id);
    if (!lane) return;
    if (lane.engine) {
      const eng = lane.engine;
      // Laisse sonner la réverbe du patch avant de couper.
      eng.out.gain.setTargetAtTime(0, clock.ctx.currentTime, 0.4);
      setTimeout(() => eng.dispose(), 3000);
    }
    clock.lanes.delete(id);
    stopClockIfIdle();
  }

  // ─── Le quantizer : une voie qui joue des notes ───
  const st = {
    on: false,
    opts: Object.assign({}, DEFAULTS, { thresholds: DEFAULTS.thresholds.slice() }),
    listeners: [],
    getVariation: () => 0,
    getPitch: () => 0.5,
    getGate: () => 1,
    getLevelGain: () => 0.9,
  };

  function quantLaneCfg() {
    return {
      getOpts: () => st.opts,
      getVariation: () => st.getVariation(),
      getGate: () => st.getGate(),
      getPitch: () => st.getPitch(),
      timbre: st.opts.timbre,
      getLevelGain: () => st.getLevelGain(),
      listener: (info) => { for (const fn of st.listeners) fn(info); },
    };
  }

  function start() {
    if (st.on) return;
    if (!setLane("quant", quantLaneCfg())) return;
    st.on = true;
  }

  function stop() {
    st.on = false;
    removeLane("quant");
  }

  global.Quantizer = {
    DEFAULTS,
    SCALES,
    TIMBRES,
    LABELS,
    NOTE_NAMES,
    PPQ,
    DELAY_BEATS,
    sanitize,
    configure(o) {
      const prev = st.opts.timbre;
      st.opts = sanitize(Object.assign({}, st.opts, o));
      if (st.on && st.opts.timbre !== prev) setLane("quant", quantLaneCfg());
    },
    // Exposé pour mesurer les niveaux hors navigateur.
    _createHost: createHost,
    get opts() { return st.opts; },
    get running() { return st.on; },
    get level() { const l = clock.lanes.get("quant"); return l ? l.lvl : 0; },
    laneLevel(id) { const l = clock.lanes.get(id); return l ? l.lvl : 0; },
    hasLane(id) { return clock.lanes.has(id); },
    bind(fns) {
      if (fns.getBpm) clock.getBpm = fns.getBpm;
      if (fns.getBus) clock.getBus = fns.getBus;
      for (const k of ["getVariation", "getPitch", "getGate", "getLevelGain"]) if (fns[k]) st[k] = fns[k];
    },
    onNote(fn) { st.listeners.push(fn); },
    start,
    stop,
    setLane,
    removeLane,
    // Le contexte a pu être recréé (changement de fréquence, réveil) : on se rebranche.
    rebind() {
      const bus = clock.getBus && clock.getBus();
      if (!bus || bus.ctx === clock.ctx) return;
      const saved = [...clock.lanes.keys()];
      ensureClock();
      if (st.on && saved.indexOf("quant") !== -1) setLane("quant", quantLaneCfg());
      if (global.dispatchEvent) global.dispatchEvent(new Event("quantizer-rebind"));
    },
  };
})(window);
