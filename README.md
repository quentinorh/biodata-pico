# Biodata Pico

Musique générée à partir des microvariations électriques d’une plante.

L’électronique du capteur est basée sur le [MIDI Sprout](https://github.com/electricityforprogress/MIDIsprout) de Sam Cusumano. Elle mesure la conductivité à la surface d’une feuille et produit un train d’impulsions. Un Raspberry Pi Pico 2 W compte la période de chaque impulsion, ouvre un point d’accès Wi-Fi et sert une interface web. Le navigateur du téléphone dessine le signal et le transforme en son avec des instruments [Faust](https://faust.grame.fr) issus d’[Ambient Garden](https://ambient.garden).

Réalisé par [Quentin Orhant](https://quentino.io) pour l’association [CC Lab](https://climatechangelab.org).

## Fonctionnement

```
feuille → capteur (impulsions) → Pico (périodes en µs) → Wi-Fi → navigateur (graphe + synthèse)
```

Le capteur oscille autour de 50 Hz, soit une période d’environ 20 000 µs. Plus la conductivité de la feuille change, plus cette période dérive. Le Pico ne fait pas de son : il mesure, filtre les valeurs aberrantes, et envoie les périodes au téléphone.

### Mesure sur le Pico

Une machine d’état PIO (`pulse_period` dans `pico_firmware/main.py`) compte la durée d’un cycle complet du signal, front montant à front montant. Elle tourne à 3 MHz et consomme trois cycles par pas, ce qui donne une résolution de 1 µs.

Chaque mesure est convertie en microsecondes et rangée dans un anneau en RAM (512 valeurs). Les périodes hors de la fenêtre 100 µs – 250 000 µs sont écartées : ce sont des parasites de commutation, pas le signal de la plante. La LED du Pico clignote d’autant plus vite que les impulsions arrivent.

### Réseau et interface

Au démarrage, le Pico ouvre le point d’accès **Plante-Musicale** (réseau ouvert, voir `pico_firmware/config.py`) et sert l’interface sur `http://192.168.4.1`. Un petit serveur DNS répond à toute requête par l’adresse du Pico, ce qui déclenche le portail captif d’Android, d’iOS et de Windows.

L’interface est une page statique (`app/`) plus quelques routes :

| Route | Rôle |
| --- | --- |
| `/api/stream` | Flux Server-Sent Events des périodes (`intervals_us`, en µs) |
| `/api/data` | Même contenu, en une seule réponse JSON |
| `/api/status` | SSID, adresse, broche du capteur, dernière période, RAM libre |
| `/api/settings` | Bibliothèque de jeux de réglages, stockée dans `settings.json` |

Les fichiers de l’interface sont déposés en gzip sur le Pico et servis avec `Content-Encoding: gzip`. La bibliothèque de réglages reste à la racine du système de fichiers, en dehors du dossier `app`, pour survivre à un redéploiement.

### Du signal au son

Le navigateur ouvre le flux SSE, trace chaque période sur le graphe, et maintient deux seuils (haut et bas) que l’on peut déplacer à la main. Trois pistes lisent le même signal, chacune avec son instrument :

- **Ambiance** — suit toute la hauteur du graphe et l’agitation globale du signal. Elle module en continu un paramètre de l’instrument (fréquence, densité, filtre…).
- **Végétal** — ne réagit qu’entre les deux seuils. Les petites variations y sont très sensibles. Les extrema locaux déclenchent des notes, à un rythme borné par le BPM.
- **Toucher** — ce qui dépasse les seuils, en particulier les attaques. Une transition (par défaut 1,2 s) fait apparaître cette piste par-dessus le végétal, qui continue de jouer. Sans impulsions, tous les sons s’éteignent de la même façon.

Les instruments sont des patches Faust précompilés (WASM), joués par le moteur [Teasynth](https://github.com/pac-dev/Teasynth). Sur le Pico, servi en HTTP, le mixage passe par un `ScriptProcessor`. En HTTPS ou sur `localhost`, un `AudioWorklet` est utilisé à la place.

Les jeux de réglages (instruments, volumes, seuils, BPM) peuvent être enregistrés sur le Pico (jusqu’à 24), ou exportés et importés en JSON.

## Matériel

- Raspberry Pi Pico **2 W**, firmware MicroPython `RPI_PICO2_W`. Le Pico W d’origine n’a pas assez de flash pour l’interface et les 18 patches.
- Carte capteur V1 : oscillateur **LMC555** en 3,3 V, inspiré du MIDI Sprout. Schéma, synthèse et nomenclature dans `pcb/` (`synthese-pcb-v1.md`, `BOM-v1-mouser.csv`).
- Sortie du 555 sur **GP15**, broche physique 20. Le pull-down est celui du Pico (firmware), pas une résistance sur la carte.
- Un téléphone ou un ordinateur pour le son : la synthèse tourne dans le navigateur, pas sur le Pico.

## Utilisation

1. Brancher le capteur sur GP15, les électrodes sur la feuille, puis alimenter le Pico.
2. Rejoindre le Wi-Fi **Plante-Musicale**.
3. Ouvrir `http://192.168.4.1` (le portail captif y mène souvent tout seul).
4. Autoriser le son, puis régler les trois pistes depuis le panneau.

Pour remettre un mot de passe WPA2, passer `WIFI_OPEN` à `False` dans `pico_firmware/config.py`. Le mot de passe prévu est `biosonique` (8 caractères minimum).

## Développer sans le Pico

`tools/dev_server.py` sert le dossier `app` et simule l’API du Pico avec un signal synthétique à 50 Hz (dérive lente et « touchers »).

```bash
python tools/dev_server.py
```

L’interface est alors sur `http://localhost:8080`.

## Déployer sur le Pico

L’interpréteur MicroPython s’installe une fois, à la main. `tools/deploy.py` copie ensuite le programme et l’interface ; il ne remplace pas cet interpréteur.

1. Télécharger le firmware du **Pico 2 W**, variante `RPI_PICO2_W` : [RPI_PICO2_W-latest.uf2](https://micropython.org/download/RPI_PICO2_W/RPI_PICO2_W-latest.uf2) ([autres versions](https://micropython.org/download/RPI_PICO2_W/)). C’est la build pour la puce RP2350 et le Wi-Fi de cette carte.
2. Maintenir le bouton **BOOTSEL** en branchant le câble USB. Un disque nommé **RP2350** apparaît.
3. Copier le `.uf2` sur ce disque. La carte redémarre sous MicroPython et le disque disparaît.

Pour changer de version plus tard, la même séquence suffit. Si MicroPython tourne déjà, `machine.bootloader()` au REPL ouvre aussi ce disque.

Le Pico doit ensuite être branché en USB, avec `mpremote` installé (`pip install mpremote`). Le script compresse l’interface, copie `main.py` et `config.py`, puis redémarre la carte. Les sources `.dsp` restent sur le PC : seuls les WASM et le catalogue partent sur la flash.

```bash
python tools/deploy.py
python tools/deploy.py --port COM16
python tools/deploy.py --quick    # firmware et fichiers principaux seulement
```

Si LittleFS est plein, le script reformate le système de fichiers. Il relit `settings.json` avant, et le réécrit après.

## Arborescence

```
pico_firmware/     MicroPython : mesure PIO, point d'accès, HTTP, DNS captif
app/               Interface web, graphe, sonification, patches Faust
pcb/               Carte capteur V1 : schéma KiCad, synthèse, nomenclature
tools/deploy.py    Copie firmware + interface gzippée sur le Pico 2 W
tools/dev_server.py  Simulateur de l'API, sans matériel
```

## Dépendances

- [MIDI Sprout](https://github.com/electricityforprogress/MIDIsprout) — électronique du capteur, Sam Cusumano
- [Ambient Garden](https://ambient.garden) — instruments Faust du paysage sonore
- [Teasynth](https://github.com/pac-dev/Teasynth) — lecture de ces patches dans le navigateur
- [Faust](https://faust.grame.fr) — langage de synthèse, GRAME
- [MicroPython](https://micropython.org) — firmware du Pico 2 W
