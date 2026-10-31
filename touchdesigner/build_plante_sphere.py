"""Construit /project1/plante_sphere dans TouchDesigner.

Dans le Textport :
    exec(open('/Users/jj/Code/claude/00_Claude/OUTPUTS/plante-carte/biodata-pico-main/touchdesigner/build_plante_sphere.py').read())

Le script relit biodata_client.py et positions.glsl dans son dossier, et
reconstruit le composant de zéro s'il existe déjà.
"""

import os

try:
    ROOT = os.path.dirname(os.path.abspath(__file__))
except NameError:
    ROOT = '/Users/jj/Code/claude/00_Claude/OUTPUTS/plante-carte/biodata-pico-main/touchdesigner'

PARENT = '/project1'
NAME = 'plante_sphere'
REPORT = []


class E:
    """Valeur en mode expression."""
    def __init__(self, expr):
        self.expr = expr


def setp(o, **values):
    for key, value in values.items():
        par = getattr(o.par, key, None)
        if par is None:
            REPORT.append('paramètre absent : %s.%s' % (o.name, key))
            continue
        if isinstance(value, E):
            par.expr = value.expr
            par.mode = ParMode.EXPRESSION
        else:
            par.val = value


def make(base, optype, name, x, y):
    o = base.create(optype, name)
    dx, dy = x - o.nodeX, y - o.nodeY
    o.nodeX, o.nodeY = x, y
    for docked in o.docked:  # les DAT du GLSL suivent leur opérateur
        docked.nodeX += dx
        docked.nodeY += dy
    o.viewer = True
    return o


def read(name):
    with open(os.path.join(ROOT, name), encoding='utf-8') as f:
        return f.read()


EXEC_CALLBACKS = """# Chaque image : lit le flux, calcule l'intensité, remplit le CHOP "signal".

import math

CHANNELS = ('intensity', 'live', 'period_us', 'baseline_us', 'deviation_us',
            'jitter_us', 'delta_us', 'rel_permil', 'rate_hz')


def onFrameStart(frame):
    comp = parent()
    client = op('client').module.get_client()
    client.configure(comp.par.Source.eval(), comp.par.Host.eval().strip())
    values = client.step(
        sensitivity=comp.par.Sensitivity.eval(),
        floor_permil=comp.par.Floorpermil.eval(),
        auto_gain=bool(comp.par.Autogain.eval()),
        baseline_tau=comp.par.Baselinetau.eval(),
    )
    signal = op('signal')
    for index, name in enumerate(CHANNELS):
        signal.par['const%dvalue' % index] = values[name]
    op('status_text').par.text = client.status_line()

    # Autorotation : chaque axe avance à sa part de la vitesse.
    spin = op('spin')
    dt = 1.0 / max(project.cookRate, 1)
    speed = math.radians(comp.par.Spin.eval())
    for index, axis in enumerate('xyz'):
        par = spin.par['const%dvalue' % index]
        rate = getattr(comp.par, 'Spin' + axis).eval()
        par.val = (par.eval() + speed * rate * dt) % (2.0 * math.pi)
    return


def onExit():
    op('client').module.get_client().stop()
    return
"""

CHANNELS = ('intensity', 'live', 'period_us', 'baseline_us', 'deviation_us',
            'jitter_us', 'delta_us', 'rel_permil', 'rate_hz')


# Palette de départ : teintes de lasers réels, saturées.
PALETTE = (
    ('rouge-orange', '#FF1C05'),
    ('rouge', '#FF0620'),
    ('ambre', '#FF7A00'),
    ('vert', '#19FF4A'),
    ('cyan', '#00E5FF'),
    ('bleu', '#2A3BFF'),
    ('violet', '#B026FF'),
    ('magenta', '#FF1FA8'),
    ('blanc-chaud', '#FFE2C8'),
)

# Forme affichée : la forme de départ, avancée par l'intensité lente si le suivi est actif.
SHAPE_EXPR = ("min(5.0, parent().par.Shape + (parent().par.Shapespan * "
              "(parent().par.Manual.eval() if parent().par.Override.eval() "
              "else op('null_shape_signal')['intensity'].eval()) "
              "if parent().par.Shapefollow.eval() else 0.0))")

COLOR_CALLBACKS = """# Palette, hex et RGB restent synchronisés.

PALETTE = %r

_busy = [False]


def _parse(text):
    text = text.strip().lstrip('#')
    if len(text) == 3:
        text = ''.join(c * 2 for c in text)
    if len(text) != 6:
        return None
    try:
        return tuple(int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return None


def _hex(rgb):
    return '#%%02X%%02X%%02X' %% tuple(int(round(max(0.0, min(1.0, v)) * 255)) for v in rgb)


def _set_rgb(comp, rgb):
    comp.par.Dotcolorr, comp.par.Dotcolorg, comp.par.Dotcolorb = rgb


def _release_palette(comp, hexvalue):
    # Les rappels arrivent en fin d'image : on ne repasse en « libre » que si la
    # couleur s'écarte vraiment du preset choisi.
    if dict(PALETTE).get(comp.par.Palette.eval(), '').upper() != hexvalue.upper():
        comp.par.Palette = 'libre'


def onValueChange(par, prev):
    if _busy[0]:
        return
    comp = par.owner
    _busy[0] = True
    try:
        if par.name == 'Palette':
            value = dict(PALETTE).get(par.eval())
            if value:
                comp.par.Dothex = value
                _set_rgb(comp, _parse(value))
        elif par.name == 'Dothex':
            rgb = _parse(par.eval())
            if rgb:
                _set_rgb(comp, rgb)
                comp.par.Dothex = _hex(rgb)
                _release_palette(comp, _hex(rgb))
        else:
            value = _hex((comp.par.Dotcolorr.eval(), comp.par.Dotcolorg.eval(),
                          comp.par.Dotcolorb.eval()))
            comp.par.Dothex = value
            _release_palette(comp, value)
    finally:
        _busy[0] = False
    return
""" % (PALETTE,)

TONEMAP_GLSL = """out vec4 fragColor;
void main()
{
	vec4 c = texture(sTD2DInputs[0], vUV.st);
	float peak = max(c.r, max(c.g, c.b));
	vec3 col = peak > 1.0 ? c.rgb / peak : c.rgb;
	fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
"""

def floats(page, rows):
    for name, label, default, lo, hi in rows:
        p = page.appendFloat(name, label=label)[0]
        p.default = default
        p.val = default
        p.normMin, p.normMax = lo, hi


def rgb(page, name, label, values):
    for par, v in zip(page.appendRGB(name, label=label), values):
        par.default = v
        par.val = v


def add_custom_pars(comp):
    page = comp.appendCustomPage('Signal')
    p = page.appendMenu('Source', label='Source')[0]
    p.menuNames = ['pico', 'simulation']
    p.menuLabels = ['Pico (Wi-Fi)', 'Simulation']
    p.default = 'pico'
    p.val = 'pico'
    p = page.appendStr('Host', label='Adresse')[0]
    p.default = '192.168.4.1'
    p.val = '192.168.4.1'
    floats(page, (
        ('Sensitivity', 'Sensibilité', 2.0, 0.0, 6.0),
        ('Floorpermil', 'Plancher (‰)', 1.0, 0.1, 20.0),
    ))
    p = page.appendToggle('Autogain', label='Gain auto')[0]
    p.default = True
    p.val = True
    floats(page, (
        ('Baselinetau', 'Ligne de base (s)', 3.0, 0.5, 20.0),
        ('Attack', 'Montée (s)', 0.04, 0.0, 1.0),
        ('Release', 'Retombée (s)', 0.9, 0.0, 4.0),
    ))
    # Pour régler la sphère sans plante : l'intensité vient du curseur.
    p = page.appendToggle('Override', label='Intensité manuelle')[0]
    p.default = False
    p = page.appendFloat('Manual', label='Intensité')[0]
    p.normMin, p.normMax = 0.0, 1.0
    p.clampMin, p.clampMax = True, True
    p.min, p.max = 0.0, 1.0

    page = comp.appendCustomPage('Sphère')
    p = page.appendInt('Count', label='Nombre de points')[0]
    p.default = 3500
    p.val = 3500
    p.normMin, p.normMax = 500, 20000
    p.clampMin, p.clampMax = True, True
    p.min, p.max = 100, 262144
    floats(page, (
        ('Radius', 'Rayon', 1.0, 0.1, 3.0),
        ('Skinshare', 'Part de surface', 0.6, 0.0, 1.0),
        ('Pop', 'Pop de surface', 1.0, 0.0, 1.0),
        ('Dispersion', 'Explosion', 0.8, 0.0, 6.0),
        ('Largeur', 'Largeur', 0.8, 0.0, 2.0),
        ('Turbulence', 'Turbulence', 0.3, 0.0, 1.0),
        ('Breath', 'Respiration', 0.015, 0.0, 0.1),
    ))
    # 0 sphère, 1 tétraèdre, 2 cube, 3 octaèdre, 4 dodécaèdre, 5 icosaèdre.
    # Forme de départ ; le signal l'avance de Shapespan crans quand il monte.
    p = page.appendFloat('Shape', label='Forme de départ')[0]
    p.normMin, p.normMax = 0.0, 5.0
    p.clampMin, p.clampMax = True, True
    p.min, p.max = 0.0, 5.0
    p = page.appendToggle('Shapefollow', label='Forme suit le signal')[0]
    p.default = True
    p.val = True
    floats(page, (
        ('Shapespan', 'Amplitude de forme', 5.0, 0.0, 5.0),
        ('Shapelag', 'Lenteur de forme (s)', 1.5, 0.0, 8.0),
    ))
    floats(page, (
        ('Spin', 'Autorotation (°/s)', 12.0, 0.0, 120.0),
        ('Spinx', 'Part de rotation X', 0.6, -1.0, 1.0),
        ('Spiny', 'Part de rotation Y', 1.0, -1.0, 1.0),
        ('Spinz', 'Part de rotation Z', 0.35, -1.0, 1.0),
    ))

    page = comp.appendCustomPage('Laser')
    p = page.appendMenu('Palette', label='Palette')[0]
    p.menuNames = ['libre'] + [name for name, _ in PALETTE]
    p.menuLabels = ['Libre'] + [name.replace('-', ' ').capitalize() for name, _ in PALETTE]
    p.default = 'rouge-orange'
    p.val = 'rouge-orange'
    p = page.appendStr('Dothex', label='Couleur (hex)')[0]
    p.default = '#FF1C05'
    p.val = '#FF1C05'
    rgb(page, 'Dotcolor', 'Couleur des points', (1.0, 0.11, 0.02))
    p = page.appendToggle('Beamsmatch', label='Faisceaux de la même couleur')[0]
    p.default = True
    p.val = True
    rgb(page, 'Beamcolor', 'Couleur des faisceaux', (1.0, 0.16, 0.05))
    rgb(page, 'Bgcolor', 'Fond', (0.086, 0.086, 0.114))  # eigengrau, #16161D
    floats(page, (
        ('Beams', 'Faisceaux', 0.03, 0.0, 0.5),
        ('Reach', 'Portée des faisceaux', 1.0, 0.0, 1.0),
        ('Dotgain', 'Éclat des points', 2.6, 0.5, 6.0),
        ('Dotsize', 'Taille des points', 0.0055, 0.002, 0.03),
        ('Flicker', 'Scintillement', 0.6, 0.0, 1.0),
        ('Vibration', 'Vibration', 1.0, 0.0, 4.0),
        ('Glow', 'Halo', 2.0, 0.0, 4.0),
    ))
    page = comp.appendCustomPage('Source')
    floats(page, (
        ('Sourcex', 'Source X', 0.0, -4.0, 4.0),
        ('Sourcey', 'Source Y', -1.6, -4.0, 4.0),
        ('Sourcez', 'Source Z', 0.3, -4.0, 4.0),
    ))


def glsl_uniforms(glsl, output):
    glsl.seq.vec.numBlocks = 8
    setp(glsl,
         vec0name='uTime', vec0valuex=E('absTime.seconds'),
         vec1name='uIntensity',
         vec1valuex=E("parent().par.Manual.eval() if parent().par.Override.eval() "
                      "else op('null_signal')['intensity'].eval()"),
         vec2name='uShape',
         vec2valuex=E('parent().par.Radius'), vec2valuey=E('parent().par.Dispersion'),
         vec2valuez=E('parent().par.Largeur'), vec2valuew=E('parent().par.Turbulence'),
         vec3name='uMotion',
         vec3valuex=0,
         vec3valuey=E('parent().par.Breath'),
         vec3valuez=E('parent().par.Skinshare'), vec3valuew=E('parent().par.Pop'),
         vec4name='uLaser',
         vec4valuex=E('parent().par.Count'), vec4valuey=E('parent().par.Flicker'),
         vec4valuez=E('parent().par.Vibration'), vec4valuew=output,
         vec5name='uSource',
         vec5valuex=E('parent().par.Sourcex'), vec5valuey=E('parent().par.Sourcey'),
         vec5valuez=E('parent().par.Sourcez'), vec5valuew=E('parent().par.Beams'),
         vec6name='uBeam', vec6valuex=E('parent().par.Reach'),
         vec7name='uSpin', vec7valuex=E("op('spin')['rx']"), vec7valuey=E("op('spin')['ry']"),
         vec7valuez=E("op('spin')['rz']"), vec7valuew=E(SHAPE_EXPR),
         outputresolution='custom', resolutionw=256,
         resolutionh=E('max(1, math.ceil(parent().par.Count / 256))'),
         format='rgba32float')


VIEW_PARS = ('Count Shape Shapefollow Shapespan Spin Sensitivity Dispersion Largeur '
             'Palette Dothex Dotcolor Beams Reach Dotgain Flicker Glow '
             'Override Manual')


def build_view(comp):
    """Deux fenêtres : le rendu laser seul, et le panneau de curseurs à part.

    Le composant affiche le rendu (aperçu, F1, fenêtre « laser »). Le panneau vit
    dans un Base COMP : un Base COMP n'est pas un panneau, donc rien de ce qu'il
    contient ne s'affiche dans le rendu. Il s'ouvre dans sa propre fenêtre.
    """
    setp(comp, w=1280, h=720, top=E("me.op('out_render')"))

    rows = len(VIEW_PARS.split())
    height = rows * 22 + 44
    ui = make(comp, baseCOMP, 'ui', 1400, -300)
    panel = make(ui, containerCOMP, 'panneau', 0, 0)
    setp(panel, w=440, h=height + 16,
         bgcolorr=0.12, bgcolorg=0.12, bgcolorb=0.13, bgalpha=1.0)
    controls = make(panel, parameterCOMP, 'controls', 0, 0)
    # combinescopes = any et pagescope vide : sinon la liste de paramètres ne filtre rien.
    setp(controls, op='../../..', header=False, pagenames=False, builtin=False, custom=True,
         pagescope='', parscope=VIEW_PARS, combinescopes='any',
         x=8, y=8, w=424, h=height)

    win_laser = make(comp, windowCOMP, 'fenetre_laser', 1400, -450)
    setp(win_laser, winop='..', title='Plante · laser', size='custom', winw=1280, winh=720,
         borders=True, interact=False)
    win_panel = make(comp, windowCOMP, 'fenetre_panneau', 1600, -450)
    setp(win_panel, winop='ui/panneau', title='Plante · réglages', size='automatic',
         borders=True, interact=True, alwaysontop=True)

    # F1 montre le rendu seul, pour la projection.
    perform = op('/perform')
    perform.par.winop = comp.path
    setp(perform, size='automatic', interact=False)
    return controls, win_laser, win_panel


def instanced_geo(comp, name, shape, x, y, material):
    geo = make(comp, geometryCOMP, name, x, y)
    for child in list(geo.children):
        child.destroy()
    gin = make(geo, inSOP, 'in1', 0, 0)
    gout = make(geo, outSOP, 'out1', 200, 0)
    gout.inputConnectors[0].connect(gin)
    gout.display = True
    gout.render = True
    geo.inputConnectors[0].connect(shape)
    setp(geo, instancing=True, instancecountmode='manual',
         numinstances=E('parent().par.Count'), material=material)
    return geo


def additive_mat(comp, name, x, y, color_par, alpha, gain=None):
    # Avec un gain > 1, le rendu en 16 bits flottants garde l'énergie au-dessus de 1 :
    # le cœur du point sature, le halo reste de la couleur, d'où l'effet fluo.
    g = (' * parent().par.%s' % gain) if gain else ''
    mat = make(comp, constantMAT, name, x, y)
    setp(mat, colorr=E('parent().par.%sr%s' % (color_par, g)),
         colorg=E('parent().par.%sg%s' % (color_par, g)),
         colorb=E('parent().par.%sb%s' % (color_par, g)), alpha=alpha,
         blending=True, srcblend='sa', destblend='one',
         depthtest=False, depthwriting=False)
    return mat


def build():
    REPORT.clear()
    parent_op = op(PARENT)
    if parent_op is None:
        parent_op = op('/').create(containerCOMP, PARENT.strip('/'))
    keep = {}
    old = parent_op.op(NAME)
    if old is not None:
        for name in ('Source', 'Host'):
            if hasattr(old.par, name):
                keep[name] = getattr(old.par, name).eval()
        try:
            old.op('client').module.get_client().stop()
        except Exception:
            pass
        old.destroy()

    comp = parent_op.create(containerCOMP, NAME)
    comp.nodeX, comp.nodeY = 0, 0
    comp.color = (0.45, 0.2, 0.15)
    add_custom_pars(comp)
    for name, value in keep.items():
        getattr(comp.par, name).val = value

    # --- Données -----------------------------------------------------------
    client = make(comp, textDAT, 'client', -200, 300)
    client.text = read('biodata_client.py')
    client.par.language = 'python'

    exe = make(comp, executeDAT, 'signal_exec', 0, 300)
    exe.text = EXEC_CALLBACKS
    setp(exe, framestart=True, active=True)

    signal = make(comp, constantCHOP, 'signal', 0, 150)
    for index, name in enumerate(CHANNELS):
        signal.par['const%dname' % index] = name

    sel = make(comp, selectCHOP, 'select_intensity', 200, 150)
    sel.inputConnectors[0].connect(signal)
    setp(sel, channames='intensity')

    lag = make(comp, lagCHOP, 'lag_intensity', 400, 150)
    lag.inputConnectors[0].connect(sel)
    setp(lag, lag1=E('parent().par.Attack'), lag2=E('parent().par.Release'))

    null_signal = make(comp, nullCHOP, 'null_signal', 600, 150)
    null_signal.inputConnectors[0].connect(lag)

    # La forme suit une version plus lente de l'intensité : elle change sur quelques secondes.
    lag_shape = make(comp, lagCHOP, 'lag_shape', 400, 0)
    lag_shape.inputConnectors[0].connect(sel)
    setp(lag_shape, lag1=E('parent().par.Shapelag * 0.4'), lag2=E('parent().par.Shapelag'))
    null_shape_signal = make(comp, nullCHOP, 'null_shape_signal', 600, 0)
    null_shape_signal.inputConnectors[0].connect(lag_shape)

    color_exec = make(comp, parameterexecuteDAT, 'color_exec', 200, 300)
    color_exec.text = COLOR_CALLBACKS
    setp(color_exec, op='..', pars='Palette Dothex Dotcolorr Dotcolorg Dotcolorb',
         valuechange=True, custom=True, builtin=False, active=True)

    # Angles d'autorotation, intégrés image par image : changer la vitesse ne fait pas sauter la forme.
    spin = make(comp, constantCHOP, 'spin', 800, 150)
    for index, name in enumerate(('rx', 'ry', 'rz')):
        spin.par['const%dname' % index] = name

    # --- Points et faisceaux (GPU), même shader, trois sorties -------------
    glsl = make(comp, glslTOP, 'glsl_points', 0, 0)
    pixel = glsl.par.pixeldat.eval()
    pixel.text = read('positions.glsl')
    glsl_uniforms(glsl, 0)
    null_points = make(comp, nullTOP, 'null_points', 200, 0)
    null_points.inputConnectors[0].connect(glsl)

    nulls = {}
    for output, name, y in ((1, 'beams', -150), (2, 'beamlight', -300)):
        g = make(comp, glslTOP, 'glsl_' + name, 0, y)
        own = g.par.pixeldat.eval()
        g.par.pixeldat = pixel.name
        if own is not None and own != pixel:
            own.destroy()
        glsl_uniforms(g, output)
        n = make(comp, nullTOP, 'null_' + name, 200, y)
        n.inputConnectors[0].connect(g)
        nulls[name] = n

    # --- Points : petites sphères --------------------------------------------
    dot = make(comp, sphereSOP, 'dot_shape', 400, 0)
    setp(dot, type='poly', rows=4, cols=6,
         radx=E('parent().par.Dotsize'), rady=E('parent().par.Dotsize'),
         radz=E('parent().par.Dotsize'))
    null_dot = make(comp, nullSOP, 'null_dot', 600, 0)
    null_dot.inputConnectors[0].connect(dot)
    dots = instanced_geo(comp, 'geo_dots', null_dot, 800, 0, 'mat_dots')
    setp(dots, instanceop='null_points', instancetx='r', instancety='g', instancetz='b',
         instancecolorop='null_points', instancecolormode='multiply',
         instancer='a', instanceg='a', instanceb='a')
    additive_mat(comp, 'mat_dots', 800, 150, 'Dotcolor', 1.0, gain='Dotgain')

    # --- Faisceaux : un segment de la source au point ------------------------
    seg = make(comp, lineSOP, 'beam_shape', 400, -300)
    setp(seg, pax=0, pay=0, paz=0, pbx=0, pby=0, pbz=1, points=2)
    null_seg = make(comp, nullSOP, 'null_beam', 600, -300)
    null_seg.inputConnectors[0].connect(seg)
    beams = instanced_geo(comp, 'geo_beams', null_seg, 800, -300, 'mat_beams')
    # Le Geometry COMP est posé sur la source ; chaque segment part de là vers son point.
    setp(beams, tx=E('parent().par.Sourcex'), ty=E('parent().par.Sourcey'),
         tz=E('parent().par.Sourcez'),
         instanceop='null_beams', instancetx='', instancety='', instancetz='',
         instancesop='null_beams', instancesx='a', instancesy='a', instancesz='a',
         instancerottoop='null_beams', instancerottoforward='posz',
         instancerottox='r', instancerottoy='g', instancerottoz='b',
         instancecolorop='null_beamlight', instancecolormode='multiply',
         instancer='r', instanceg='g', instanceb='b')
    mat_beams = additive_mat(comp, 'mat_beams', 800, -450, 'Beamcolor', 1.0)
    for ch in 'rgb':
        setp(mat_beams, **{'color' + ch: E('parent().par.Dotcolor%s if parent().par.Beamsmatch '
                                           'else parent().par.Beamcolor%s' % (ch, ch))})

    cam = make(comp, cameraCOMP, 'cam1', 1000, -450)
    setp(cam, tz=6.0, fov=40.0)

    # --- Rendu ---------------------------------------------------------------
    render = make(comp, renderTOP, 'render1', 1000, 0)
    setp(render, camera='cam1', geometry='geo_beams geo_dots', lights='',
         outputresolution='custom', resolutionw=1920, resolutionh=1080,
         antialias='aa8', format='rgba16float', bgcolorr=E('parent().par.Bgcolorr'),
         bgcolorg=E('parent().par.Bgcolorg'), bgcolorb=E('parent().par.Bgcolorb'),
         bgcolora=1.0)

    bloom = make(comp, bloomTOP, 'glow', 1200, 0)
    bloom.inputConnectors[0].connect(render)
    setp(bloom, bloomintensity=E('parent().par.Glow'), bloomthreshold=0.6)

    # Ramène les valeurs > 1 sans changer la teinte : un ambre reste ambre au lieu
    # de virer au jaune quand un canal sature.
    tone = make(comp, glslTOP, 'tonemap', 1400, -150)
    tone.inputConnectors[0].connect(bloom)
    tone.par.pixeldat.eval().text = TONEMAP_GLSL
    setp(tone, format='rgba16float')

    out_render = make(comp, nullTOP, 'out_render', 1400, 0)
    out_render.inputConnectors[0].connect(tone)
    out = make(comp, outTOP, 'out1', 1600, 0)
    out.inputConnectors[0].connect(out_render)

    status = make(comp, textTOP, 'status_text', 600, 300)
    setp(status, outputresolution='custom', resolutionw=1100, resolutionh=60,
         fontsizex=22, alignx='left', aligny='center')

    controls, win_laser, win_panel = build_view(comp)

    # Vérifie que les références de chemin résolvent.
    checks = [(render, 'camera'), (comp, 'top'), (controls, 'op'),
              (win_laser, 'winop'), (win_panel, 'winop')]
    for g in (dots, beams):
        checks += [(g, 'instanceop'), (g, 'instancecolorop'), (g, 'material')]
    checks += [(beams, 'instancesop'), (beams, 'instancerottoop')]
    for o, name in checks:
        par = getattr(o.par, name, None)
        if par is not None and par.eval() is None:
            REPORT.append('référence vide : %s.%s = %r' % (o.name, name, par.val))

    print('plante_sphere construit.' if not REPORT else '\n'.join(REPORT))
    return comp


build()
