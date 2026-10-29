// Overtone singing vocal synth in Faust

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
f1raw = hslider("f1", 228, 30, 400, 0.001);
f1 = max(25, min(280, f1raw));
f2amtbase = hslider("f2amt", 0, 0, 0.5, 0.0001);

// freqs, Qs and amps for "tenor a/e" formants
fs1 = (650, 1080, 2650, 2900, 3250);
fs2 = (400, 1700, 2600, 3200, 3580);
qs1 = (8, 12, 22, 22, 23);
qs2 = (6, 21, 26, 27, 30);
as1 = (1, 0.5, 0.45, 0.4, 0.08);
as2 = (1, 0.12, 0.25, 0.12, 0.08);

// freqs, Qs and amps for tuned filters
tfs = (8, 16, 32, 64);
tqs = (4, 5, 8, 5);
tas = (0.3, 0.4, 0.25, 0.1);

nyq = ma.SR * 0.43;
clampF(f) = max(30, min(nyq, f));

// automation
atk1 = ba.time != 0 : en.are(12, 12);
atk2 = ba.time != 0 : en.are(2, 2);
press = 0.6;
f2 = clampF(f1*6 + f1*4*no.lfnoise(0.2));
f2amt = f2amtbase * (1 + no.lfnoise(1)*0.2);
ampatk = press : si.lag_ud(0.1, 0.01);
vowel = 0.25 + f2amt*0.5 + 0.25*no.lfnoise(0.6);
f1vib = f1 * (1 + atk1*0.01*os.osc(5+os.osc(0.5))) * (0.5 + 0.5*atk2);

// Exciter: filtered oscillators
saw = os.sawtooth(f1vib)*0.5;
noise = no.noise * (0.2 - 0.2*f2amt);
exc = (saw + noise) * 0.1;

// Body: formants (crossfade two static formant banks instead of per-sample tan() in 5 filters)
form1(i) = fi.resonbp(ba.take(i+1, fs1), ba.take(i+1, qs1), ba.take(i+1, as1));
form2(i) = fi.resonbp(ba.take(i+1, fs2), ba.take(i+1, qs2), ba.take(i+1, as2));
bank1 = _ <: par(i, 5, form1(i)) :> _;
bank2 = _ <: par(i, 5, form2(i)) :> _;
forms(amp) = _ <: (bank1 * (1 - vowel) * amp), (bank2 * vowel * amp);

ctrlforms(amt) = * (0.5*amt) : fi.lowpass(1, 15000) <:
	(fi.resonbp(f2, 1, 1) : fi.resonbp(f2, 1, 1)), 
	(fi.resonbp(clampF(f2*4), 2, 1) : fi.resonbp(clampF(f2*4), 2, 1))*0.4*(f2*4 < nyq),
	fi.highpass(1, 1600);

tfreq(i) = f1 * ba.take(i+1, tfs);
tuner(i) = fi.resonlp(clampF(tfreq(i)), ba.take(i+1, tqs), 1) * ba.take(i+1, tas) * (tfreq(i) < nyq);
tuners(amp) = par(i, 4, tuner(i)*amp);
ctrlend(amp) = _ <: fi.resonbp(f2, 9, 1)*amp, fi.resonbp(clampF(f2*2), 6, 1)*amp*(f2*2 < nyq),
	fi.highpass(1, 1600) :> _;

om = fi.lowpass(3, min(15000, 15000*atk1*atk1 + 50));

body = _ 
<: forms(1 - f2amt*0.8), ctrlforms(f2amt) :> _ 
<: *(0.2), tuners(1 - f2amt*0.5) :> _ 
<: *(1 - f2amt*0.5), ctrlend(f2amt) :> om;

process = exc : body : *(ampatk);
