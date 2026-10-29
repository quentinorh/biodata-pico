// String-like waveguide instrument in Faust

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
freq = hslider("freq", 80, 30, 2000, 0.001) : max(35) : min(2200);
lp1 = hslider("lp1", 3300, 100, 15000, 0.0001) : max(80) : min(15000);
lp2 = hslider("lp2", 580, 100, 15000, 0.0001) : max(80) : min(15000);
noise1amt = hslider("noise", 0, 0, 1, 0.0001);

// Exciter: filtered oscillator
noise1 = no.noise * noise1amt * 0.5 : fi.lowpass(1, lp1) : fi.lowpass(2, lp2)*2;
exc = noise1 : fi.highpass(2, min(8000, freq*1.2)) : fi.notchw(10, min(12000, freq)) : fi.notchw(5, min(14000, freq*2)) : _*2;

// Waveguide filters and non-linearity
wgbottom = 10 + freq * 0.1;
wgtop = min(15000, 140 + freq*1.75);
NL(x) = x / ( (x*x) + 1 );

// Convert frequency to delay line length in samples
wgf2samp(f) = max(4, min(8900, 1.011 / (max(30, f) + ((0.1786*f*f)/(wgtop+wgbottom)) ) : ba.sec2samp));

// Waveguide loop
reso = loop(vibrato) with {
	vibrato = freq * (1 + os.osc(5) * 0.006);
	wgf = fi.lowpass(1, wgtop) : fi.highpass(1, wgbottom);
	wg(f) = de.fdelay2(9000, wgf2samp(f)) : wgf : NL * 1.4;
	loop(f) = + ~ wg(f);
};

process = exc : reso;
