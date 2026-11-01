// Sphère laser. Un pixel = un point. Toutes les lignes partent d'une même source,
// comme un projecteur laser qui balaie des points dans la brume.
//
// Le même shader tourne trois fois (uLaser.w) :
//   0 → RGB = position du point, A = luminosité du point
//   1 → RGB = direction source → point, A = longueur du faisceau × portée
//   2 → RGBA = luminosité du faisceau
//
// Signal faible : la peau pop par plaques. Signal fort : le cœur s'allume et éclate.
//
// Forme : 0 sphère, 1 tétraèdre, 2 cube, 3 octaèdre, 4 dodécaèdre, 5 icosaèdre.
// Entre deux entiers, les points glissent d'un solide à l'autre.

uniform float uTime;
uniform float uIntensity;   // 0..1, lissé côté CHOP
uniform vec4 uShape;        // rayon, explosion, largeur, turbulence
uniform vec4 uMotion;       // -, respiration, part de surface, pop
uniform vec4 uLaser;        // nombre de points, scintillement, vibration, sortie
uniform vec4 uSource;       // position de la source (xyz), intensité des faisceaux
uniform vec4 uBeam;         // portée des faisceaux depuis la source (0..1), -, -, -
uniform vec4 uSpin;         // angles de rotation X, Y, Z (rad), forme (0..5)

out vec4 fragColor;

uint pcg(uint v)
{
	uint state = v * 747796405u + 2891336453u;
	uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
	return (word >> 22u) ^ word;
}

float rand(uint v)
{
	return float(pcg(v)) / 4294967295.0;
}

const float PHI = 1.61803398875;
const float IPHI = 0.61803398875;
const float SQRT3 = 1.73205080757;

// Projette une direction unitaire sur la surface d'un solide de Platon de
// circonrayon 1 : le rayon touche la face la plus « en face » à la distance
// inrayon / max(d · n). Les faces symétriques sont couvertes par abs(d).
vec3 solid(int kind, vec3 d)
{
	vec3 a = abs(d);
	float support;
	float inradius;
	if (kind == 1) {        // tétraèdre
		support = max(max(dot(d, vec3(1, 1, 1)), dot(d, vec3(1, -1, -1))),
			max(dot(d, vec3(-1, 1, -1)), dot(d, vec3(-1, -1, 1)))) / SQRT3;
		inradius = 1.0 / 3.0;
	} else if (kind == 2) { // cube
		support = max(a.x, max(a.y, a.z));
		inradius = 1.0 / SQRT3;
	} else if (kind == 3) { // octaèdre
		support = (a.x + a.y + a.z) / SQRT3;
		inradius = 1.0 / SQRT3;
	} else if (kind == 4) { // dodécaèdre : normales = sommets de l'icosaèdre
		support = max(a.y + PHI * a.z, max(a.x + PHI * a.y, PHI * a.x + a.z))
			/ sqrt(1.0 + PHI * PHI);
		inradius = 0.79465447;
	} else if (kind == 5) { // icosaèdre : normales = sommets du dodécaèdre
		support = max(max(a.x + a.y + a.z, IPHI * a.y + PHI * a.z),
			max(IPHI * a.x + PHI * a.y, PHI * a.x + IPHI * a.z)) / SQRT3;
		inradius = 0.79465447;
	} else {                // sphère
		return d;
	}
	// Mise à l'échelle : la moyenne inrayon / circonrayon vaut 1, comme la sphère.
	// Sinon le tétraèdre paraît minuscule à côté d'elle.
	return d * inradius / max(support, 1e-4) * (2.0 / (1.0 + inradius));
}

vec3 shapeAt(float form, vec3 d)
{
	float f = clamp(form, 0.0, 5.0);
	int lo = int(floor(f));
	int hi = min(lo + 1, 5);
	float m = smoothstep(0.0, 1.0, f - float(lo));
	return mix(solid(lo, d), solid(hi, d), m);
}

void main()
{
	ivec2 res = ivec2(uTDOutputInfo.res.zw);
	ivec2 px = ivec2(gl_FragCoord.xy);
	int index = px.y * res.x + px.x;
	float count = max(uLaser.x, 1.0);
	if (float(index) >= count) {
		fragColor = vec4(0.0);
		return;
	}
	uint id = uint(index);
	float i = float(index);

	// Sphère de Fibonacci : répartition régulière, sans pôles chargés.
	float y = 1.0 - 2.0 * (i + 0.5) / count;
	float r = sqrt(max(0.0, 1.0 - y * y));
	float phi = 6.28318530718 * fract(i * 0.61803398875);
	vec3 dir = vec3(cos(phi) * r, y, sin(phi) * r);

	// Le solide est défini dans son propre repère, puis tourne sur lui-même sur 3 axes.
	// La dispersion vient après : l'élargissement reste horizontal à l'écran.
	mat3 spin = TDRotateZ(uSpin.z) * TDRotateY(uSpin.y) * TDRotateX(uSpin.x);
	vec3 surface = spin * shapeAt(uSpin.w, dir);
	dir = spin * dir;

	float r1 = rand(id * 5u + 1u);
	float r2 = rand(id * 5u + 2u);
	float r3 = rand(id * 5u + 3u);
	float r4 = rand(id * 5u + 4u);
	float r5 = rand(id * 5u + 5u);

	float radius = uShape.x;
	float k = clamp(uIntensity, 0.0, 1.0);
	float t = uTime;
	bool skin = r1 < uMotion.z;

	// Champ de turbulence, échantillonné sur la direction.
	vec3 q = dir * 1.6;
	vec3 turb = vec3(
		TDSimplexNoise(vec4(q, 11.0 + t * 0.08)),
		TDSimplexNoise(vec4(q + 7.3, 23.0 + t * 0.08)),
		TDSimplexNoise(vec4(q - 4.1, 37.0 + t * 0.08)));

	// Profondeur au repos : 1 pour la peau, réparti dans le volume pour le cœur.
	float depth = skin ? 1.0 : 0.04 + 0.88 * pow(r3, 0.3333);

	// Peau : des plaques qui bougent vite. Un signal faible fait sauter les plus hautes.
	float plate = 0.5 + 0.5 * TDSimplexNoise(vec4(dir * 2.4, t * 0.7));
	float popK = clamp(k * 1.4, 0.0, 1.0) * uMotion.w * 0.6;
	float pop = skin ? smoothstep(1.0 - popK, 1.0 - popK + 0.08, plate * 0.85 + r2 * 0.15) : 0.0;

	// Cœur : au-delà de 0,3 il s'allume, du bord vers le centre à mesure que le signal monte.
	float burstK = smoothstep(0.3, 1.0, k);
	float threshold = skin ? 0.0 : (1.0 - depth) * 0.85 + r4 * 0.1;
	float burst = smoothstep(threshold, threshold + 0.2, burstK);

	vec3 flow = normalize(dir + turb * uShape.w * 2.0);
	float reach = pop * (0.05 + 0.3 * r5 * r5)
		+ burst * uShape.y * (0.25 + 1.0 * r5 * r5) * (skin ? 0.1 : 1.0);
	vec3 offset = flow * reach * radius;
	float w = uShape.z;
	offset *= vec3(1.0 + 1.5 * w, max(0.0, 1.0 - 0.7 * w), max(0.0, 1.0 - 0.75 * w));

	vec3 rest = surface * radius * depth;
	vec3 p = rest + offset + turb * radius * uMotion.y * (0.25 + k);

	// Vibration des miroirs : un tremblement rapide, plus fort quand la plante s'agite.
	float tick = floor(t * 60.0);
	vec3 jitter = vec3(rand(id * 7u + uint(tick)), rand(id * 11u + uint(tick) * 3u),
		rand(id * 13u + uint(tick) * 5u)) - 0.5;
	p += jitter * radius * uLaser.z * (0.004 + 0.02 * k);

	// Le cœur reste éteint tant qu'il n'éclate pas.
	float visible = skin ? 1.0 : smoothstep(0.0, 0.15, burst);

	// Scintillement : chaque point clignote à sa propre cadence, sur un fond de 50 Hz.
	float flick = rand(id * 17u + uint(floor(t * (18.0 + 24.0 * r2))));
	float hum = 0.5 + 0.5 * sin(t * 314.159 + r3 * 6.2832);
	float sparkle = mix(1.0, 0.35 + 0.65 * flick * (0.7 + 0.3 * hum), uLaser.y);
	float bright = visible * sparkle * min(1.0 + 0.3 * pop + 0.3 * burst, 1.25);

	vec3 toPoint = p - uSource.xyz;
	float beamLen = length(toPoint) * visible;

	if (uLaser.w < 0.5) {
		fragColor = TDOutputSwizzle(vec4(p, bright));
	} else if (uLaser.w < 1.5) {
		// Le faisceau part de la source ; à portée 1 il touche le point.
		fragColor = TDOutputSwizzle(vec4(normalize(toPoint), beamLen * clamp(uBeam.x, 0.0, 1.0)));
	} else {
		// Un faisceau sur trois est plus présent : la brume n'est jamais uniforme.
		float beam = uSource.w * bright * (r4 < 0.33 ? 1.0 : 0.35);
		fragColor = TDOutputSwizzle(vec4(vec3(beam), beam));
	}
}
