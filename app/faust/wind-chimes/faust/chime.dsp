// Chime instrument in Faust using modal synthesis

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
freq = hslider("freq", 500, 50, 2000, 0.001) : max(60) : min(2200);
noiseAmt = hslider("noise", 0, 0, 1, 0.0001);

nyq = ma.SR * 0.44;
safeMode(f, t60, g) = pm.modeFilter(min(nyq, max(40, f)), t60, g * (f < nyq));

// Exciter: a filtered oscillator
exc = no.pink_noise * noiseAmt * 0.5;

// Modal body
body = exc <:
	safeMode(freq, 1.2, 0.1),
	safeMode(freq*2.778, 1.2, 0.1),
	safeMode(freq*5.18, 1.2, 0.1),
	safeMode(freq*8.163, 1.2, 0.1),
	safeMode(freq*11.66, 1.2, 0.1),
	safeMode(freq*15.638, 1.2, 0.1),
	safeMode(freq*20, 1.2, 0.1)
:> _;

process = body;
