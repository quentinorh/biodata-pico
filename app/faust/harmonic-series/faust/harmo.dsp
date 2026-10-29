// Harmonic series instrument in Faust. An abstract waveguide.

import("stdfaust.lib");

// Use "sliders" to add parameters to control the instrument
// "sdelay"s are delay line lengths in samples
fb = hslider("fb", 0, 0, 2, 0.0001) : max(0) : min(1.2) : si.smoo;
amp = hslider("amp", 0, 0, 1, 0.001) : si.smoo;
preamp = hslider("preamp", 1, 0, 1, 0.0001);
sdelay1 = hslider("sdelay1", 1000, 1, 9000, 0.1) : max(4) : min(8900) : si.smoo;
sdelay2 = hslider("sdelay2", 1000, 1, 9000, 0.1) : max(4) : min(8900) : si.smoo;
locut = hslider("locut", 500, 50, 2050, 0.001) : max(40) : min(8000);
hicut = hslider("hicut", 500, 50, 2050, 0.001) : max(60) : min(12000);

// Non-linearity
NL(x) = x / ( (x*x) + 1 );

// Exciter: filtered oscillator
exc = no.noise * 0.01 : fi.lowpass(2, 600);

// Waveguide loop
body = _ <: de.fdelay2(9000, sdelay1), de.fdelay2(9000, sdelay2)
	:> fi.highpass(1, locut) : fi.lowpass(1, hicut)
	: NL * fb;
loop = + ~ body;

// Post-processing
rev_st = re.zita_rev1_stereo(0, 200, 6000, 10, 20, 44100);
post = _*preamp <: rev_st : co.limiter_1176_R4_stereo : *(0.7), *(0.7);

process = exc : loop : *(amp) : post;
