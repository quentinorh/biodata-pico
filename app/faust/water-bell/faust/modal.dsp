// Bell instrument in Faust using modal synthesis

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
freq = hslider("freq", 500, 50, 2000, 0.001) : max(50) : min(1800);
lp1 = hslider("lp1", 400, 100, 10000, 0.0001);
mode0 = hslider("mode0", 0, 0, 1, 0.0001) : si.smoo;
mode1 = hslider("mode1", 0, 0, 1, 0.0001) : si.smoo;
mode2 = hslider("mode2", 0, 0, 1, 0.0001) : si.smoo;
mode3 = hslider("mode3", 0, 0, 1, 0.0001) : si.smoo;
mode4 = hslider("mode4", 0, 0, 1, 0.0001) : si.smoo;

nyq = ma.SR * 0.44;
safeMode(f, t60, g) = pm.modeFilter(min(nyq, max(40, f)), t60, g * (f < nyq));

// Exciter: a filtered oscillator
exc = no.noise * 0.2 : fi.lowpass(1, lp1*3);

// Some LFOs to add movement to the modes
lf = os.osc(0.7) * 0.5 + 0.5;
lf2 = os.oscp(0.7, 3) * 0.5 + 0.5;

// Modal body (bonang panerus modal analysis)
barCore = exc <:
	(_ * mode0 : safeMode(freq*1.0, 39.92, 0.1) : _ * lf),
	(_ * mode0 : safeMode(freq*2.005, 19.73, 0.12) : _ * lf2),
	(_ * mode1 : safeMode(freq*2.39, 18.84, 0.05) : _ * lf),
	(_ * mode1 : safeMode(freq*3.015, 15.4, 0.05) : _ * lf2),
	(_ * mode2 : safeMode(freq*3.67, 5.34, 0.05) : _ * lf),
	(_ * mode2 : safeMode(freq*4.01, 4.48, 0.1) : _ * lf2),
	(_ * mode3 : safeMode(freq*5.37, 4.22, 0.02) : _ * lf),
	(_ * mode3 : safeMode(freq*5.97, 4.39, 0.04) : _ * lf2),
	(_ * mode4 : safeMode(freq*8.18, 4.6, 0.03) : _ * lf),
	(_ * mode4 : safeMode(freq*10.58, 4.39, 0.03) : _ * lf)
:> _;

process = barCore;
