/**
 * Réglages de base « moyen-age », chargés par défaut.
 * Changer `baseVersion` les fait recharger une fois sur chaque appareil (et sur la carte),
 * même s'il avait déjà ses propres réglages.
 * Quantizer en Cordes à 2 %, octave −2, une note tous les 8 temps, gamme Hirajōshi,
 * pistes en fond, 50 BPM, réverbe Abbatiale. Végétal (arbre) en Cordes, Toucher (main) en
 * Contrebasse à 75 %. Seuils dynamiques (marge 75 %), centrage et zoom auto (marge 250 %, zoom auto coupé sur mobile),
 * entrée du toucher 750 ms.
 */
window.PLANTE_DEFAULT_CONFIG = {
  "version": 4,
  "app": "plante-musicale",
  "title": "moyen-age",
  "mix": {
    "masterVol": 33,
    "vegetalVol": 55,
    "interVol": 60,
    "bpm": 50
  },
  "display": {
    "graphAnimations": true,
    "autoCenter": true,
    "autoZoom": true
  },
  "general": {
    "dynamicThresholds": true,
    "threshMarginPct": 75,
    "threshSmoothMs": 2500,
    "zoomMarginPct": 250,
    "zoomSmoothMs": 600,
    "zoneXfadeMs": 750,
    "zoneXfade": true,
    "reverb": "abbatiale",
    "reverbMix": 74,
    "quantOn": true,
    "quant": {
      "every": 8,
      "ternary": false,
      "cap": 3,
      "timbre": "cordes",
      "scale": "hirajoshi",
      "root": 9,
      "level": 2,
      "octave": -2,
      "withTracks": true,
      "thresholds": [
        0.03,
        0.21167402846562264,
        0.5171329139338776
      ]
    },
    "autoCenter": true,
    "autoZoom": true,
    "visibleCount": 400
  },
  "roles": {
    "vegetal": {
      "on": true,
      "inst": "moon-strings",
      "param": "density",
      "modSmooth": 0.4,
      "modAmount": 80,
      "modSense": 36,
      "modMotion": 50,
      "modInvert": false,
      "vals": {},
      "spans": {},
      "tiers": {
        "thresholds": [
          0.22,
          0.46,
          0.72
        ]
      },
      "instruments": {
        "wind-chimes": {
          "param": "freq1",
          "vals": {
            "freq1": 600,
            "tightness": 0,
            "lp1": 350,
            "density": 1
          },
          "spans": {
            "density": {
              "lo": 0.9039192708333333,
              "m1": 2.4383515625000003,
              "m2": 1.5321015624999998,
              "hi": 2.9461917890484255
            }
          }
        },
        "sparse-soprano": {
          "param": "freq1",
          "vals": {},
          "spans": {}
        },
        "moon-strings": {
          "param": "density",
          "vals": {},
          "spans": {}
        }
      }
    },
    "interaction": {
      "on": true,
      "inst": "contrabass",
      "param": "freq1",
      "modSmooth": 0.15,
      "modAmount": 85,
      "modSense": 100,
      "modMotion": 40,
      "modInvert": false,
      "vals": {
        "preamp": 0.75
      },
      "spans": {},
      "tiers": {
        "thresholds": [
          0.22,
          0.46,
          0.72
        ]
      },
      "instruments": {
        "wind-bells": {
          "param": "tightness",
          "vals": {
            "tightness": 0
          },
          "spans": {
            "tightness": {
              "lo": 0,
              "hi": 2.8374556422995023
            },
            "density": {
              "lo": 2.3387645356772397,
              "hi": 0.3194496915433746
            }
          }
        },
        "contrabass": {
          "param": "freq1",
          "vals": {
            "preamp": 0.75
          },
          "spans": {}
        }
      }
    }
  },
  "baseVersion": "2026-10-31.5"
};
