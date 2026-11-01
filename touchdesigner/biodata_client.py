"""Client du flux biodata pour TouchDesigner.

Lit le flux Server-Sent Events du Pico (``/api/stream``) dans un thread,
et calcule à chaque image une intensité entre 0 et 1 : l'écart entre la
période récente et sa ligne de base lente, plus l'agitation d'un échantillon
à l'autre. Une plante calme donne 0, un toucher pousse vers 1.

Aucune dépendance à TouchDesigner : le module se teste aussi en Python seul
contre ``tools/dev_server.py``.
"""

import collections
import json
import math
import random
import sys
import threading
import time
import types
import urllib.request

MIN_US = 100          # mêmes bornes que le firmware
MAX_US = 250_000
BASE_PERIOD_US = 20_000
OFFLINE_AFTER_S = 1.5  # sans donnée depuis ce délai, l'intensité retombe à 0

# Le registre survit au rechargement du DAT : un seul thread vivant à la fois.
_REG = sys.modules.setdefault(
    "plante_biodata_registry", types.ModuleType("plante_biodata_registry")
)


def _median(values):
    ordered = sorted(values)
    return ordered[len(ordered) >> 1]


class BiodataClient:
    def __init__(self):
        self.lock = threading.Lock()
        self.queue = collections.deque(maxlen=8192)
        self.thread = None
        self.stop_event = None
        self.source = None
        self.host = None
        self.state = "idle"
        self.state_t = time.monotonic()
        self.error = ""
        self.last_rx = 0.0
        # Caractéristiques du signal
        self.baseline = None
        self.period = 0.0
        self.deviation = 0.0
        self.jitter = 0.0
        self.delta = 0.0
        self.rel = 0.0
        self.peak = 0.0
        self.intensity = 0.0
        self.rate = 0.0
        self._count = 0
        self._count_t = time.monotonic()
        self._last_step = time.monotonic()

    # ---------------------------------------------------------------- threads
    def configure(self, source, host):
        """Démarre ou redémarre le lecteur si la source ou l'hôte change."""
        alive = self.thread is not None and self.thread.is_alive()
        if alive and source == self.source and host == self.host:
            return
        self.stop()
        self.source, self.host = source, host
        self.error = ""
        self.state = "idle"
        self.state_t = time.monotonic()
        self.baseline = None
        self.peak = 0.0
        self.stop_event = threading.Event()
        target = self._run_simulation if source == "simulation" else self._run_stream
        self.thread = threading.Thread(
            target=target, args=(self.stop_event, host), daemon=True,
            name="plante-biodata",
        )
        self.thread.start()

    def stop(self):
        if self.stop_event is not None:
            self.stop_event.set()
        self.thread = None
        self.state = "idle"

    def _push(self, intervals):
        with self.lock:
            self.queue.extend(intervals)
            self.last_rx = time.monotonic()

    def _set_state(self, stop, state, error=""):
        # Un thread arrêté ne réécrit plus l'état du suivant.
        if not stop.is_set():
            if state != self.state:
                self.state_t = time.monotonic()
            self.state = state
            self.error = error

    def _run_stream(self, stop, host):
        # Pas de proxy : le Pico est sur le réseau local.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        backoff = 0.5
        while not stop.is_set():
            url = "http://%s/api/stream" % host
            try:
                self._set_state(stop, "connexion")
                with opener.open(url, timeout=5) as response:
                    self._set_state(stop, "live")
                    backoff = 0.5
                    for raw in response:
                        if stop.is_set():
                            return
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            message = json.loads(line[5:])
                        except ValueError:
                            continue
                        intervals = message.get("intervals_us") or []
                        if intervals:
                            self._push(intervals)
                        else:
                            # Message vide : le Pico est vivant, la plante ne bat pas.
                            with self.lock:
                                self.last_rx = time.monotonic()
                self._set_state(stop, "coupé")
            except Exception as exc:  # réseau absent, 503 si deux clients, etc.
                self._set_state(stop, "hors ligne", str(exc)[:120])
            stop.wait(backoff)
            backoff = min(backoff * 2.0, 4.0)

    def _run_simulation(self, stop, host):
        """Même générateur que tools/dev_server.py : dérive lente et touchers."""
        self._set_state(stop, "simulation")
        touch_until = 0.0
        while not stop.is_set():
            now = time.monotonic()
            batch = []
            elapsed = 0.0
            while elapsed < 0.03:
                drift = 60 * math.sin(now / 7.0) + random.gauss(0, 25)
                if now > touch_until and random.random() < 0.004:
                    touch_until = now + random.uniform(1.0, 3.0)
                if now < touch_until:
                    drift += random.choice((-1, 1)) * random.uniform(800, 2800)
                period = int(BASE_PERIOD_US + drift)
                batch.append(period)
                elapsed += period / 1_000_000
            self._push(batch)
            stop.wait(elapsed)

    # ------------------------------------------------------------ main thread
    def step(self, sensitivity=2.0, floor_permil=1.0, auto_gain=True, baseline_tau=3.0):
        """À appeler une fois par image. Renvoie un dict de valeurs.

        Tout est relatif à la période de base : le capteur ne tourne pas à la
        même fréquence d'une plante à l'autre (3,6 ms mesurées sur la plante
        de test, 20 ms prévues par le README).
        """
        now = time.monotonic()
        dt = min(max(now - self._last_step, 1e-4), 0.5)
        self._last_step = now
        with self.lock:
            batch = list(self.queue)
            self.queue.clear()
            last_rx = self.last_rx
        batch = [v for v in batch if MIN_US <= v <= MAX_US]
        live = (now - last_rx) < OFFLINE_AFTER_S

        # Chien de garde : une connexion bloquée plus de 8 s est relancée.
        if self.source == "pico" and self.state == "connexion" and now - self.state_t > 8.0:
            self.thread = None
            self.configure(self.source, self.host)

        if batch:
            self._count += len(batch)
            median = _median(batch)
            if self.baseline is None:
                self.baseline = median
            # Rejet des parasites isolés : plus de 40 % d'écart à la ligne de base.
            batch = [v for v in batch if abs(v - self.baseline) < 0.4 * self.baseline] or [median]
            median = _median(batch)
            if len(batch) > 1:
                diffs = [abs(batch[i] - batch[i - 1]) for i in range(1, len(batch))]
                self.jitter = _median(diffs)
            else:
                self.jitter = abs(median - self.period) if self.period else 0.0
            # Variation d'un lot à l'autre : c'est elle qui rend la sphère nerveuse.
            self.delta = abs(median - self.period) if self.period else 0.0
            self.deviation = abs(median - self.baseline)
            self.period = median
            alpha = 1.0 - math.exp(-dt / max(baseline_tau, 0.1))
            self.baseline += (median - self.baseline) * alpha
        else:
            self.delta *= math.exp(-dt / 0.15)

        if not live:
            self.deviation = 0.0
            self.jitter = 0.0
            self.delta = 0.0

        raw_us = max(self.deviation, 2.0 * self.jitter, 2.0 * self.delta)
        base = max(self.baseline or 0.0, 1.0)
        self.rel = raw_us / base  # fraction de la période
        # Gain automatique : crête qui retombe en ~8 s, sans descendre sous le plancher.
        floor = max(floor_permil, 0.01) / 1000.0
        self.peak = max(self.rel, self.peak * math.exp(-dt / 8.0))
        scale = max(floor, self.peak) if auto_gain else floor
        normalized = self.rel / scale
        # Courbe < 1 : les petites variations ressortent davantage.
        self.intensity = min(max(normalized * sensitivity * 0.5, 0.0) ** 0.7, 1.0)

        if now - self._count_t >= 1.0:
            self.rate = self._count / (now - self._count_t)
            self._count = 0
            self._count_t = now

        return {
            "intensity": self.intensity,
            "live": 1.0 if live else 0.0,
            "period_us": float(self.period),
            "baseline_us": float(self.baseline or 0.0),
            "deviation_us": float(self.deviation),
            "jitter_us": float(self.jitter),
            "delta_us": float(self.delta),
            "rel_permil": float(self.rel * 1000.0),
            "rate_hz": float(self.rate),
        }

    def status_line(self):
        return "%s  %s  %.0f µs  %.0f Hz  écart %.2f ‰  intensité %.2f%s" % (
            self.source or "-", self.state, self.period, self.rate, self.rel * 1000.0,
            self.intensity,
            ("  " + self.error) if self.error and self.state != "live" else "",
        )


def get_client():
    client = getattr(_REG, "client", None)
    if type(client) is not BiodataClient:  # module rechargé : on remplace
        if client is not None:
            try:
                client.stop()
            except Exception:
                pass
        client = BiodataClient()
        _REG.client = client
    return client
