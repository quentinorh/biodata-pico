// Vibraphone instrument in Faust using modal synthesis

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
freq = hslider("freq", 500, 50, 2000, 0.001) : max(50) : min(1800);
noiseAmt = hslider("noise", 0, 0, 1, 0.0001);
lp1 = hslider("lp1", 400, 100, 10000, 0.0001);

nyq = ma.SR * 0.44;
safeMode(f, t60, g) = pm.modeFilter(min(nyq, max(40, f)), t60, g * (f < nyq));

// Exciter: a filtered oscillator
exc = no.noise * noiseAmt * 0.05 : fi.lowpass(1, lp1) : fi.lowpass(2, 3000);

// Modal body
barCore = exc <:
	safeMode(freq, 2, 0.1),
	safeMode(freq*3.984, 0.8, 0.2),
	safeMode(freq*10.668, 0.3, 0.06)
:> _;

process = barCore;
