# Synthèse PCB V1 — capteur Pico Sylvestre Orchestre

Oscillateur LMC555 en 3,3 V, bornier électrodes, une LED sur la sortie du 555, mesure de période sur le Pico.

Schémas d’origine : [MIDI Sprout Schematic](<https://github.com/electricityforprogress/MIDIsprout/blob/master/MIDI%20Sprout%20Schematic.png>), [schéma v008](https://github.com/electricityforprogress/MIDIsprout/blob/master/MIDI_Sprout_Schematic_008.png)

Nomenclature d’achat : [`BOM-v1-mouser.csv`](BOM-v1-mouser.csv)

Schéma de la carte : [`Schematic.pdf`](Schematic.pdf)

---

## 1. Choix

| Fonction               | Choix V1                                                | Référence                                                                   |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Timer                  | **LMC555** DIP-8, soudé                          | `LMC555CN/NOPB`                                                             |
| Alimentation           | **3V3 du Pico**                                   | pin 36 (`3V3`)                                                              |
| R1                     | 100 kΩ film métal **1 %** axial                 | Stackpole `RNMF14FTC100K`                                                   |
| Condensateur de timing | **4,7 nF C0G/NP0** radial                         | TDK `FG18C0G1H472JNT06` (Mouser `810-FG18C0G1H472JNT6`)                   |
| Découplage 555        | **100 nF X7R + 47 µF / 25 V radial**             | `C315C104K5R5TA` + Panasonic `ECE-A1EKA470` (Mouser `667-ECE-A1EKA470`) |
| CONT (broche 5)        | 10 nF C0G 100 V vers GND                                | TDK `FG14C0G2A103JNT06` (Mouser `810-FG14C0G2A103JNT6`)                   |
| LED                    | **1 × verte** `LTL-1CHGE` sur OUT              | Vf typ. 2,1 V ; équivalent jaune `LTL-1CHYE`                               |
| Protection GPIO        | 470 Ω en série OUT → Pico                            | `RNMF14FTC470R`                                                             |
| Électrodes            | bornier vis **2 plots 3,5 mm**, entrée latérale | GCT `TAD05-02-1-L-G` (Mouser `640-TAD05-02-1-L-G`)                        |
| Pico                   | **2 pin sockets 1×20** femelles 2,54 mm          | Same Sky `SSK02-FPH-254-A20`                                                |
| Mesure Pico            | période + duty cycle (PIO / timer)                     | GP15                                                                          |

---

## 2. Découplage

C2 et C3 sont en parallèle entre VCC (broche 8) et GND (broche 1) du LMC555.

| Ref          | Valeur                   | Rôle                   | Placement                         |
| ------------ | ------------------------ | ----------------------- | --------------------------------- |
| **C3** | 100 nF X7R 50 V radial   | HF, pics de commutation | collé aux broches 8 et 1         |
| **C2** | 47 µF / 25 V alu radial | BF, bruit du 3V3        | patte longue **+ vers 3V3** |
| **C4** | 10 nF C0G 100 V          | broche CONT → GND      | près du 555                      |

---

## 3. Résistances

Axiales film métal 1 %, 0,25 W (Stackpole RNMF14).

| Ref          | Valeur  | Rôle                                        |
| ------------ | ------- | -------------------------------------------- |
| **R1** | 100 kΩ | 3V3 → DISCH                                 |
| **R2** | 470 Ω  | OUT → GP15                                  |
| **R3** | 470 Ω  | OUT → LED D1 (~2,6 mA : (3,3 − 2,1) / 470) |

---

## 4. LED

Une LED verte sur OUT, comme le schéma analogique MIDI Sprout.

```text
U1.3 OUT ──┬── R3 470 Ω ── D1 anode ── cathode ── GND
           └── R2 470 Ω ── GP15 Pico
```

Anode (patte longue) vers R3 ; cathode (patte courte) vers GND. Elle s’éteint si l’oscillateur s’arrête.

---

## 5. Câblage LMC555

| Broche | Nom   | Connexion V1                                   |
| ------ | ----- | ---------------------------------------------- |
| 1      | GND   | GND Pico                                       |
| 2      | TRIG  | THRES + bornier pin 1 (`prob_A`) + C1        |
| 3      | OUT   | R3 → D1, et R2 → GP15                        |
| 4      | RESET | 3V3                                            |
| 5      | CONT  | C4 10 nF → GND                                |
| 6      | THRES | relié à TRIG                                 |
| 7      | DISCH | R1 100 kΩ → 3V3 + bornier pin 2 (`prob_B`) |
| 8      | VCC   | 3V3 + C2 + C3                                  |

---

## 6. Bornier électrodes

**GCT** `TAD05-02-1-L-G` — 2 plots, pas 3,50 mm, THT, entrée latérale (fils parallèles à la carte), 16–30 AWG.

- Plot **1** (net `prob_A`) → TRIG/THRES
- Plot **2** (net `prob_B`) → DISCH

---

## 7. Pico

Deux receptacles femelles 1×20, pas 2,54 mm. Le Pico porte des headers mâles 2,54 mm.

| Ref          | Pièce                | Rangée Pico                          |
| ------------ | --------------------- | ------------------------------------- |
| **J2** | `SSK02-FPH-254-A20` | pins **1–20** (GP0 … GP15)    |
| **J3** | `SSK02-FPH-254-A20` | pins **21–40** (SWCLK … VBUS) |

Toutes les pins du Raspberry pi pico 2 W sont disponibles sur les bords du PCB.

---

## 8. Nomenclature

| Ref    | Valeur                           | Rôle                                        |
| ------ | -------------------------------- | -------------------------------------------- |
| U1     | LMC555 DIP-8                     | oscillateur (soudé)                         |
| R1     | 100 kΩ 1 %                      | 3V3 → DISCH                                 |
| R2     | 470 Ω 1 %                       | série GPIO                                  |
| R3     | 470 Ω 1 %                       | série LED                                   |
| C1     | 4,7 nF C0G 50 V, pas 2,5 mm      | timing (`FG18C0G1H472JNT06`)               |
| C2     | 47 µF / 25 V radial, pas 2,5 mm | découplage BF, polarisé (`ECE-A1EKA470`) |
| C3     | 100 nF X7R                       | découplage HF                               |
| C4     | 10 nF C0G 100 V, pas 2,5 mm      | CONT (`FG14C0G2A103JNT06`)                 |
| D1     | LTL-1CHGE                        | impulsions, verte                            |
| J1     | TAD05-02-1-L-G                   | électrodes / R test                         |
| J2, J3 | SSK02-FPH-254-A20 ×2            | supports du Pico                             |
| A1     | Pico 2 W (`SC1634`)            | enfiché, headers mâles 2,54 mm             |

---

## 9. Schéma

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
