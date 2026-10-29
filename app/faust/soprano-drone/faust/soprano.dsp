// Soprano vocal synth in Faust

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
f1 = hslider("f1", 200, 30, 1000, 0.001) : max(52) : min(6000);
noiseAmt = hslider("noise", 0, 0, 1, 0.0001);
sawAmt = hslider("saw", 0, 0, 1, 0.0001);

// freqs, Qs and amps for soprano formants
sop_a_freq = (800, 1150, 2900, 3900, 4950);
sop_o_freq = (450, 800, 2830, 3800, 4950);
sop_a_amp = (1, 0.501, 0.025, 0.1, 0.003);
sop_o_amp = (1, 0.282, 0.079, 0.079, 0.003);
sop_a_q = (10, 13, 24, 30, 35);
sop_o_q = (11, 10, 28, 32, 41);

nyq = ma.SR * 0.44;
clampF(f) = max(50, min(nyq, f));

// Exciter: filtered oscillators
saw = os.sawtooth(f1) * sawAmt * 0.4 : fi.lowpass(1, clampF(f1*1.5)) : fi.lowpass(1, clampF(500+f1));
noise = no.noise * 0.01 * noiseAmt : fi.ffbcombfilter(1/50 : ba.sec2samp, max(2, 1/f1 : ba.sec2samp), 0.9) : fi.lowpass(2, clampF(600 + f1*1.5));
exc = saw*0.8 + noise;

// Body: formant bank (crossfade between 'a' and 'o' formants to avoid per-sample tan() in fi.resonbp)
vowel = os.osc(0.3)*0.12+0.18;
formA(i) = fi.resonbp(ba.take(i+1, sop_a_freq), ba.take(i+1, sop_a_q), ba.take(i+1, sop_a_amp));
formO(i) = fi.resonbp(ba.take(i+1, sop_o_freq), ba.take(i+1, sop_o_q), ba.take(i+1, sop_o_amp));
bankA = _ <: par(i, 5, formA(i)) :> _;
bankO = _ <: par(i, 5, formO(i)) :> _;

hform = fi.resonbp(5500, 10, 0.2);
anti = fi.notchw(300, 2000) : fi.notchw(600, 3500);
forms = _ <: (bankA * (1 - vowel)), (bankO * vowel), hform :> anti;
process = exc : forms;
