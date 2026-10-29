# Synthèse PCB V1 — capteur plante (MIDI Sprout × Pico)

Oscillateur LMC555 en 3,3 V, bornier électrodes, une LED sur la sortie du 555, mesure de période sur le Pico.

Schémas d’origine : [MIDI Sprout Schematic](<https://github.com/electricityforprogress/MIDIsprout/blob/master/MIDI%20Sprout%20Schematic.png>), [schéma v008](https://github.com/electricityforprogress/MIDIsprout/blob/master/MIDI_Sprout_Schematic_008.png). Nomenclature d’achat : [`BOM-v1-mouser.csv`](BOM-v1-mouser.csv). Schéma de la carte : [`PCB_arbre_qui_chante/PCB_arbre_qui_chante.pdf`](PCB_arbre_qui_chante/PCB_arbre_qui_chante.pdf).

---

## 1. Décisions

| Fonction               | Choix V1                                                | Référence                                                                   |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Timer                  | **LMC555** DIP-8, soudé                          | `LMC555CN/NOPB` (remplaçant : `TLC555CP`)                                |
| Alimentation           | **3V3 du Pico**                                   | pin 36 (`3V3`)                                                              |
| `R_A`                | 100 kΩ film métal **1 %** axial                 | Stackpole `RNMF14FTC100K`                                                   |
| Condensateur de timing | **4,7 nF C0G/NP0** radial, pas 2,5 mm             | TDK `FG18C0G1H472JNT06` (Mouser `810-FG18C0G1H472JNT6`)                   |
| Découplage 555        | **100 nF X7R + 47 µF / 25 V radial**             | `C315C104K5R5TA` + Panasonic `ECE-A1EKA470` (Mouser `667-ECE-A1EKA470`) |
| CONT (broche 5)        | 10 nF C0G 100 V vers GND, pas 2,5 mm                    | TDK `FG14C0G2A103JNT06` (Mouser `810-FG14C0G2A103JNT6`)                   |
| LED                    | **1 × verte** `LTL-1CHGE` sur OUT              | Vf typ. 2,1 V ; équivalent jaune `LTL-1CHYE`                               |
| Protection GPIO        | 470 Ω en série OUT → Pico                            | `RNMF14FTC470R`                                                             |
| Électrodes            | bornier vis **2 plots 3,5 mm**, entrée latérale | GCT `TAD05-02-1-L-G` (Mouser `640-TAD05-02-1-L-G`)                        |
| Pico                   | **2 pin sockets 1×20** femelles 2,54 mm          | Same Sky `SSK02-FPH-254-A20`                                                |
| Mesure Pico            | période + duty cycle (PIO / timer)                     | GP15                                                                          |

Écarts par rapport au MIDI Sprout analogique :

|                        | MIDI Sprout                                | V1                                                             |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| C1 timing              | 4,7 nF X7R (libellé schéma « 0.0042 ») | 4,7 nF **C0G/NP0**                                       |
| C2                     | 47 µF / 25 V alu radial                   | 47 µF / **25 V** alu radial, pas 2,5 mm, Ø 6,3 × 7 mm |
| 100 nF                 | Z5U                                        | **X7R** 50 V                                             |
| CONT                   | rien                                       | **10 nF** → GND                                         |
| 1 µF                  | absent                                     | absent                                                         |
| Second 100 nF (ATmega) | présent                                   | absent                                                         |

---

## 2. Découplage

C2 et C3 sont en parallèle entre VCC (broche 8) et GND (broche 1) du LMC555.

| Ref          | Valeur                                               | Rôle                   | Placement                                         |
| ------------ | ---------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| **C3** | 100 nF X7R 50 V radial                               | HF, pics de commutation | collé aux broches 8 et 1                         |
| **C2** | 47 µF / 25 V alu radial, pas 2,5 mm, Ø 6,3 × 7 mm | BF, bruit du 3V3        | à proximité ; patte longue **+ vers 3V3** |
| **C4** | 10 nF C0G 100 V, pas 2,5 mm                          | broche CONT → GND      | près du 555                                      |

---

## 3. Résistances

Axiales film métal 1 %, 0,25 W (Stackpole RNMF14).

| Ref          | Valeur  | Rôle                                        |
| ------------ | ------- | -------------------------------------------- |
| **R1** | 100 kΩ | `R_A` : 3V3 → DISCH                       |
| **R2** | 470 Ω  | OUT → GP15                                  |
| **R3** | 470 Ω  | OUT → LED D1 (~2,6 mA : (3,3 − 2,1) / 470) |

Kit de calibration (non soudé, à serrer sur le bornier) : `10k, 22k, 47k, 100k, 220k, 470k, 1M`.

---

## 4. LED

Une LED verte sur OUT, comme le schéma analogique MIDI Sprout.

```text
U1.3 OUT ──┬── R3 470 Ω ── D1 anode ── cathode ── GND
           └── R2 470 Ω ── GP15 Pico
```

Anode = patte longue ; cathode (méplat) vers GND. À quelques centaines de Hz / kHz, D1 paraît allumée en continu (duty ~50 %). Elle s’éteint si l’oscillateur s’arrête.

---

## 5. Câblage LMC555

| Broche | Nom   | Connexion V1                                      |
| ------ | ----- | ------------------------------------------------- |
| 1      | GND   | GND Pico                      |
| 2      | TRIG  | THRES + bornier pin 1 (`prob_A`) + C1 |
| 3      | OUT   | R3 → D1, et R2 → GP15                |
| 4      | RESET | 3V3                                    |
| 5      | CONT  | C4 10 nF → GND                        |
| 6      | THRES | relié à TRIG                         |
| 7      | DISCH | R1 100 kΩ → 3V3 + bornier pin 2 (`prob_B`) |
| 8      | VCC   | 3V3 + C2 + C3                 |

---

## 6. Bornier électrodes

**GCT** `TAD05-02-1-L-G` — 2 plots, pas 3,50 mm, THT, entrée latérale (fils parallèles à la carte), 16–30 AWG.

- Plot **1** (net `prob_A`) → TRIG/THRES
- Plot **2** (net `prob_B`) → DISCH

Même bornier pour une résistance étalon : jamais plante et R en même temps. Câbles torsadés, courts. Pads TENS ou inox.

---

## 7. Calibration

1. Déconnecter la plante.
2. Serrer une R 1 % connue sur le bornier.
3. Mesurer période, fréquence, duty cycle.
4. Répéter le kit 10 kΩ → 1 MΩ.
5. Tracer `f = g(R)` : fonction de transfert de cette carte.
6. Rebrancher les électrodes.

Logger la fréquence brute (`timestamp, period, frequency, duty`). Pas de conversion live fréquence → ohms.

---

## 8. Pico

Deux receptacles femelles 1×20, pas 2,54 mm. Le Pico porte des headers mâles 2,54 mm.

| Ref          | Pièce                | Rangée Pico                          |
| ------------ | --------------------- | ------------------------------------- |
| **J2** | `SSK02-FPH-254-A20` | pins **1–20** (GP0 … GP15)    |
| **J3** | `SSK02-FPH-254-A20` | pins **21–40** (SWCLK … VBUS) |

Empreinte KiCad : `PinSocket_1x20_P2.54mm_Vertical`. Entraxe des rangées : **17,78 mm**. USB du Pico du côté des pins 40 / 1.

| Signal           | Pin Pico                                          | Socket  |
| ---------------- | ------------------------------------------------- | ------- |
| 3V3              | pin **36** (`3V3`)                        | J3      |
| GND              | pin **38** (et/ou 3, 8, 13, 18, 23, 28, 33) | J2 / J3 |
| OUT 555 (via R2) | **GP15** = pin **20**                 | J2      |

Pas de composants hauts sous le Pico. Le 555, les condensateurs et le bornier vont autour de l’empreinte. Alimentation : USB du Pico → 3V3. Firmware : PIO / timer matériel (période + duty).

---

## 9. Nomenclature

| Ref    | Valeur                           | Rôle                                        |
| ------ | -------------------------------- | -------------------------------------------- |
| U1     | LMC555 DIP-8                     | oscillateur (soudé)                         |
| R1     | 100 kΩ 1 %                      | charge `R_A`                               |
| R2     | 470 Ω 1 %                       | série GPIO                                  |
| R3     | 470 Ω 1 %                       | série LED                                   |
| C1     | 4,7 nF C0G 50 V, pas 2,5 mm      | timing (`FG18C0G1H472JNT06`)               |
| C2     | 47 µF / 25 V radial, pas 2,5 mm | découplage BF, polarisé (`ECE-A1EKA470`) |
| C3     | 100 nF X7R                       | découplage HF                               |
| C4     | 10 nF C0G 100 V, pas 2,5 mm      | CONT (`FG14C0G2A103JNT06`)                 |
| D1     | LTL-1CHGE                        | impulsions, verte                            |
| J1     | TAD05-02-1-L-G                   | électrodes / R test                         |
| J2, J3 | SSK02-FPH-254-A20 ×2            | supports du Pico                            |
| A1     | Pico 2 W (`SC1634`)              | enfiché, headers mâles 2,54 mm              |

---

## 10. Schéma

```text
Pico 3V3 ──┬── C3 100 nF ── GND     } collés au 555
           └── C2 47 µF+ ── GND     } + du chimique vers 3V3
           │
           ├── R1 100 kΩ ── DISCH (U1.7) ── bornier pin 2 (`prob_B`) ─┐
           │                                                              plante ou R_test
           │            TRIG+THRES ── bornier pin 1 (`prob_A`) ───────────┘
           │                          │
           │                         C1 4,7 nF C0G ── GND
           │
           ├── RESET (U1.4)
           └── CONT (U1.5) ── C4 10 nF ── GND

U1.3 OUT ──┬── R3 470 Ω ── D1 ── GND
           └── R2 470 Ω ── GP15 Pico
```

Ordre de grandeur (`C = 4,7 nF`) :

f \approx \frac{1{,}44}{(100\mathrm{k}\Omega + 2\cdot R_x)\cdot 4{,}7\mathrm{nF}}

`R_x = 100 kΩ` → ~1 kHz ; `R_x = 1 MΩ` → ~140 Hz ; `R_x ≈ 3 MΩ` → ~50 Hz, le régime décrit pour une feuille dans le README. La courbe réelle se mesure au bornier.

---

## 11. Hors V1

- Capteurs T / H / lumière
- Second LMC555 (canal de référence)
- Alimentation intermittente du 555
- Jack 3,5 mm
- MIDI, ATmega
- Conversion live fréquence → ohms
