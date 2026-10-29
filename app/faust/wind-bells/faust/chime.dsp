// Bell instrument in Faust using modal synthesis

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
	safeMode(freq*1.0, 1.2, 0.07),
	safeMode(freq*4.95, 1.2, 0.05),
	safeMode(freq*7.9, 1.2, 0.05),
	safeMode(freq*11.9, 1.2, 0.1),
	safeMode(freq*15.7, 1.2, 0.1),
	safeMode(freq*20, 1.2, 0.1)
:> _;

process = body;
