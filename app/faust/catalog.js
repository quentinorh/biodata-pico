window.FAUST_CATALOG = {
  "patches": [
    {
      "id": "contrabass",
      "label": "Contrebasse",
      "dsp": [
        "faust/contrabass.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 25,
          "max": 220,
          "def": 50,
          "freq": true
        },
        {
          "id": "flatten",
          "label": "Planéité",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 100,
          "max": 10000,
          "def": 3300,
          "freq": false
        },
        {
          "id": "texamp",
          "label": "Texture",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "texvar",
          "label": "Variation",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.374
    },
    {
      "id": "harmonic-series",
      "label": "Harmoniques",
      "dsp": [
        "faust/harmo.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 25,
          "max": 400,
          "def": 100,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.228
    },
    {
      "id": "melodic-bottle",
      "label": "Bouteille mélodique",
      "dsp": [
        "faust/bottle.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 100,
          "max": 1600,
          "def": 400,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 150,
          "max": 2000,
          "def": 600,
          "freq": true
        },
        {
          "id": "hilen",
          "label": "Durée aiguë",
          "min": 4,
          "max": 105,
          "def": 9,
          "freq": false
        },
        {
          "id": "breath",
          "label": "Souffle",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "trem",
          "label": "Trémolo",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "modes",
          "label": "Modes",
          "min": 0,
          "max": 4,
          "def": 4,
          "freq": false
        },
        {
          "id": "bounce",
          "label": "Rebond",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.322
    },
    {
      "id": "melodic-soprano",
      "label": "Soprano mélodique",
      "dsp": [
        "faust/post.dsp",
        "faust/soprano.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 200,
          "max": 3200,
          "def": 800,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 225,
          "max": 3600,
          "def": 900,
          "freq": true
        },
        {
          "id": "minFreq",
          "label": "Fréq. min",
          "min": 50,
          "max": 3000,
          "def": 350,
          "freq": true
        },
        {
          "id": "maxFreq",
          "label": "Fréq. max",
          "min": 50,
          "max": 3000,
          "def": 1000,
          "freq": true
        },
        {
          "id": "complexity",
          "label": "Complexité",
          "min": 0,
          "max": 3,
          "def": 1,
          "freq": false
        },
        {
          "id": "skip",
          "label": "Sauts",
          "min": 0,
          "max": 12,
          "def": 0,
          "freq": false
        },
        {
          "id": "slowness",
          "label": "Lenteur",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.228
    },
    {
      "id": "moon-strings",
      "label": "Cordes",
      "dsp": [
        "faust/pluck.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 200,
          "max": 3200,
          "def": 800,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 225,
          "max": 3600,
          "def": 900,
          "freq": true
        },
        {
          "id": "lp",
          "label": "Filtre",
          "min": 50,
          "max": 2000,
          "def": 350,
          "freq": false
        },
        {
          "id": "fb",
          "label": "Résonance",
          "min": 0,
          "max": 0.9,
          "def": 0,
          "freq": false
        },
        {
          "id": "delfb",
          "label": "Écho",
          "min": 0,
          "max": 1,
          "def": 0.5,
          "freq": false
        },
        {
          "id": "density",
          "label": "Densité",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "flatness",
          "label": "Planéité",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "density",
      "level": 1.14
    },
    {
      "id": "ocean-theme",
      "label": "Océan",
      "dsp": [
        "faust/bass.dsp",
        "faust/post.dsp",
        "faust/string.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 200,
          "max": 3200,
          "def": 800,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 160,
          "max": 2560,
          "def": 640,
          "freq": true
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 100,
          "max": 15000,
          "def": 700,
          "freq": false
        },
        {
          "id": "lp2",
          "label": "Filtre 2",
          "min": 100,
          "max": 15000,
          "def": 1200,
          "freq": false
        },
        {
          "id": "bassiness",
          "label": "Graves",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "freeze",
          "label": "Gel",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.369
    },
    {
      "id": "rain-stick",
      "label": "Bâton de pluie",
      "dsp": [
        "faust/stick.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "pitch",
          "label": "Hauteur",
          "min": 0,
          "max": 1,
          "def": 0.5,
          "freq": false
        },
        {
          "id": "density",
          "label": "Densité",
          "min": 1,
          "max": 80,
          "def": 10,
          "freq": false,
          "rate": true
        }
      ],
      "defaultParam": "density",
      "level": 1.14
    },
    {
      "id": "resonant-drone",
      "label": "Résonance",
      "dsp": [
        "faust/post.dsp",
        "faust/reso.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "inertia",
          "label": "Inertie",
          "min": 0,
          "max": 60,
          "def": 0,
          "freq": false
        },
        {
          "id": "impact",
          "label": "Impact",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "ofs",
          "label": "Décalage",
          "min": 0,
          "max": 1,
          "def": 0.09,
          "freq": false
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 100,
          "max": 15000,
          "def": 15000,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 25,
          "max": 400,
          "def": 100,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 43.75,
          "max": 700,
          "def": 175,
          "freq": true
        },
        {
          "id": "freq3",
          "label": "Fréquence 3",
          "min": 25,
          "max": 200,
          "def": 50,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.263
    },
    {
      "id": "sine-drone",
      "label": "Drone sinusoïdal",
      "dsp": [
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 100,
          "max": 1600,
          "def": 400,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 150,
          "max": 2400,
          "def": 600,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.232
    },
    {
      "id": "soprano-drone",
      "label": "Drone soprano",
      "dsp": [
        "faust/post.dsp",
        "faust/soprano.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 100,
          "max": 1600,
          "def": 400,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 150,
          "max": 2400,
          "def": 600,
          "freq": true
        },
        {
          "id": "slowness",
          "label": "Lenteur",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "inertia",
          "label": "Inertie",
          "min": 0,
          "max": 60,
          "def": 0,
          "freq": false
        },
        {
          "id": "hicut",
          "label": "Coupure aiguë",
          "min": 0,
          "max": 9,
          "def": 9,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.326
    },
    {
      "id": "sparse-bottle",
      "label": "Bouteille éparse",
      "dsp": [
        "faust/bottle.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 60,
          "max": 1200,
          "def": 200,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 80,
          "max": 1600,
          "def": 300,
          "freq": true
        },
        {
          "id": "breath",
          "label": "Souffle",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "modes",
          "label": "Modes",
          "min": 0,
          "max": 4,
          "def": 4,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.619
    },
    {
      "id": "sparse-soprano",
      "label": "Soprano éparse",
      "dsp": [
        "faust/post.dsp",
        "faust/soprano.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 75,
          "max": 1200,
          "def": 300,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.8
    },
    {
      "id": "vibraphones",
      "label": "Vibraphones",
      "dsp": [
        "faust/post.dsp",
        "faust/vib.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 4,
          "def": 1,
          "freq": false
        },
        {
          "id": "impact",
          "label": "Impact",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 80,
          "max": 1500,
          "def": 300,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 90,
          "max": 1750,
          "def": 350,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.458
    },
    {
      "id": "vocal-overtones",
      "label": "Overtones",
      "dsp": [
        "faust/post.dsp",
        "faust/tuvan.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "num",
          "label": "Voix",
          "min": 1,
          "max": 2,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 30,
          "max": 260,
          "def": 80,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 35,
          "max": 280,
          "def": 100,
          "freq": true
        }
      ],
      "defaultParam": "freq1",
      "level": 0.644
    },
    {
      "id": "water-bell",
      "label": "Cloche d'eau",
      "dsp": [
        "faust/modal.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 100,
          "max": 1600,
          "def": 400,
          "freq": true
        },
        {
          "id": "interval",
          "label": "Intervalle",
          "min": -1,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "inistrum",
          "label": "Attaque",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.875
    },
    {
      "id": "wind-bells",
      "label": "Cloches de vent",
      "dsp": [
        "faust/chime.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 150,
          "max": 1800,
          "def": 600,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 200,
          "max": 2000,
          "def": 800,
          "freq": true
        },
        {
          "id": "tightness",
          "label": "Serrage",
          "min": 0,
          "max": 6.5,
          "def": 0,
          "freq": false
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 50,
          "max": 2000,
          "def": 350,
          "freq": false
        },
        {
          "id": "density",
          "label": "Densité",
          "min": 0.1,
          "max": 3,
          "def": 1.7,
          "freq": false,
          "rate": true
        }
      ],
      "defaultParam": "density",
      "level": 0.554
    },
    {
      "id": "wind-chimes",
      "label": "Carillons",
      "dsp": [
        "faust/chime.dsp",
        "faust/post.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 150,
          "max": 1800,
          "def": 600,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 200,
          "max": 2000,
          "def": 800,
          "freq": true
        },
        {
          "id": "tightness",
          "label": "Serrage",
          "min": 0,
          "max": 6.5,
          "def": 0,
          "freq": false
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 50,
          "max": 2000,
          "def": 350,
          "freq": false
        },
        {
          "id": "density",
          "label": "Densité",
          "min": 0.1,
          "max": 3,
          "def": 1,
          "freq": false,
          "rate": true
        }
      ],
      "defaultParam": "density",
      "level": 0.386
    },
    {
      "id": "wind-theme",
      "label": "Thème du vent",
      "dsp": [
        "faust/bass.dsp",
        "faust/post.dsp",
        "faust/reed.dsp"
      ],
      "params": [
        {
          "id": "preamp",
          "label": "Volume",
          "min": 0,
          "max": 1,
          "def": 1,
          "freq": false
        },
        {
          "id": "freq1",
          "label": "Fréquence 1",
          "min": 200,
          "max": 3200,
          "def": 800,
          "freq": true
        },
        {
          "id": "freq2",
          "label": "Fréquence 2",
          "min": 160,
          "max": 2560,
          "def": 640,
          "freq": true
        },
        {
          "id": "lp1",
          "label": "Filtre",
          "min": 100,
          "max": 15000,
          "def": 2000,
          "freq": false
        },
        {
          "id": "bassiness",
          "label": "Graves",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        },
        {
          "id": "freeze",
          "label": "Gel",
          "min": 0,
          "max": 1,
          "def": 0,
          "freq": false
        }
      ],
      "defaultParam": "freq1",
      "level": 0.243
    }
  ]
};
