"""Simulateur de l'API du Pico, pour travailler l'interface sans matériel.

Sert le dossier ``app`` et reproduit ``/api/stream``, ``/api/data``,
``/api/status`` et ``/api/settings`` avec un signal biodata synthétique à 50 Hz.

    python tools/dev_server.py        puis http://localhost:8080
    python tools/dev_server.py --replay biodata-....json
                                      rejoue en boucle un enregistrement du datalogger
"""

import argparse
import json
import math
import os
import random
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")

BASE_PERIOD_US = 20_000
RING_SIZE = 512
STREAM_INTERVAL_S = 0.03
STREAM_BATCH = 48
STREAM_PRIME_POINTS = 120
KEEPALIVE_S = 3.0


class FakeSensor:
    """Génère des périodes plausibles : dérive lente plus « touchers ». """

    def __init__(self):
        self.lock = threading.Lock()
        self.periods = [0] * RING_SIZE
        self.write_index = 0
        self.sequence = 0
        self.dropped = 0
        self.last_period = BASE_PERIOD_US
        self.touch_until = 0.0

    def start(self):
        thread = threading.Thread(target=self._run, daemon=True)
        thread.start()

    def _next_period(self, now):
        drift = 60 * math.sin(now / 7.0) + random.gauss(0, 25)
        if now > self.touch_until and random.random() < 0.004:
            self.touch_until = now + random.uniform(1.0, 3.0)
        if now < self.touch_until:
            drift += random.choice((-1, 1)) * random.uniform(800, 2800)
        return int(BASE_PERIOD_US + drift)

    def _run(self):
        while True:
            now = time.monotonic()
            period = self._next_period(now)
            with self.lock:
                self.periods[self.write_index] = period
                self.write_index = (self.write_index + 1) % RING_SIZE
                self.sequence += 1
                self.last_period = period
            time.sleep(period / 1_000_000)

    def snapshot(self, after, limit):
        with self.lock:
            newest = self.sequence
            available = min(newest - after, RING_SIZE, limit)
            if available <= 0:
                return newest, []
            index = (newest - available) % RING_SIZE
            points = []
            for _ in range(available):
                points.append(self.periods[index])
                index = (index + 1) % RING_SIZE
            return newest, points


class ReplaySensor(FakeSensor):
    """Rejoue un fichier du datalogger, en boucle, au rythme des périodes enregistrées."""

    def __init__(self, path):
        super().__init__()
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        samples = data.get("samples", []) if isinstance(data, dict) else []
        self.recorded = [
            int(v)
            for sample in samples
            for v in (sample.get("intervals_us") or [])
            if isinstance(v, (int, float)) and v > 0
        ]
        if not self.recorded:
            raise SystemExit("Aucune période dans " + path)
        self.cursor = 0
        self.last_period = self.recorded[0]

    def _next_period(self, now):
        period = self.recorded[self.cursor]
        self.cursor = (self.cursor + 1) % len(self.recorded)
        return period


sensor = FakeSensor()
settings_lock = threading.Lock()
SETTINGS_MAX_BYTES = 96 * 1024
SETTINGS_MAX_PRESETS = 24
settings_library = {"v": 1, "active": "", "next": 1, "presets": []}


def _valid_preset_id(value):
    return isinstance(value, str) and value.isdigit() and 1 <= len(value) <= 8


def _preset_title(raw):
    if not isinstance(raw, str):
        return "Sans titre"
    text = raw.strip()
    return text[:80] if text else "Sans titre"


def _library_summary(library):
    items = []
    for preset in library.get("presets") or []:
        if not isinstance(preset, dict) or not _valid_preset_id(str(preset.get("id", ""))):
            continue
        items.append({"id": str(preset["id"]), "title": preset.get("title") or "Sans titre"})
    return {"active": library.get("active") or "", "presets": items}


def _save_preset(parsed):
    if not isinstance(parsed, dict) or parsed.get("app") != "plante-musicale":
        return "invalid", "", None
    title = _preset_title(parsed.get("title"))
    parsed = dict(parsed)
    parsed["title"] = title
    wanted = parsed.pop("id", None)
    if not isinstance(wanted, str):
        wanted = None
    with settings_lock:
        library = settings_library
        presets = library.setdefault("presets", [])
        found = None
        if _valid_preset_id(wanted):
            for preset in presets:
                if str(preset.get("id")) == wanted:
                    found = preset
                    break
        if found is None:
            if len(presets) >= SETTINGS_MAX_PRESETS:
                return "full", "", None
            next_id = int(library.get("next") or 1)
            preset_id = str(next_id)
            library["next"] = next_id + 1
            presets.insert(0, {"id": preset_id, "title": title, "config": parsed})
        else:
            preset_id = str(found["id"])
            found["title"] = title
            found["config"] = parsed
        library["active"] = preset_id
        summary = _library_summary(library)
    return None, preset_id, summary


def _activate_preset(preset_id):
    if not _valid_preset_id(preset_id):
        return "invalid", None
    with settings_lock:
        known = any(str(preset.get("id")) == preset_id for preset in settings_library.get("presets") or [])
        if not known:
            return "missing", _library_summary(settings_library)
        settings_library["active"] = preset_id
        return None, _library_summary(settings_library)


def _delete_preset(preset_id):
    if not _valid_preset_id(preset_id):
        return "invalid", None
    with settings_lock:
        presets = settings_library.get("presets") or []
        kept = [preset for preset in presets if str(preset.get("id")) != preset_id]
        if len(kept) == len(presets):
            return "missing", _library_summary(settings_library)
        settings_library["presets"] = kept
        if settings_library.get("active") == preset_id:
            settings_library["active"] = ""
        return None, _library_summary(settings_library)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=APP_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if "/api/stream" not in self.path:
            super().log_message(fmt, *args)

    def _query_int(self, key, default):
        if "?" not in self.path:
            return default
        for item in self.path.split("?", 1)[1].split("&"):
            if item.startswith(key + "="):
                try:
                    return int(item.split("=", 1)[1])
                except ValueError:
                    return default
        return default

    def _json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/stream":
            self._stream()
        elif path == "/api/data":
            sequence, intervals = sensor.snapshot(self._query_int("after", 0), 160)
            self._json({"seq": sequence, "intervals_us": intervals, "dropped": sensor.dropped})
        elif path == "/api/status":
            self._json(
                {
                    "ssid": "Plante-Musicale",
                    "ip": "127.0.0.1",
                    "sensor_pin": 15,
                    "period_us": sensor.last_period,
                    "samples": sensor.sequence,
                    "dropped": sensor.dropped,
                    "clients": 1,
                    "free_ram": 123456,
                }
            )
        elif path == "/api/settings":
            self._send_settings()
        else:
            if path.endswith(".wasm"):
                self.extensions_map[".wasm"] = "application/wasm"
            elif path.endswith(".dsp"):
                self.extensions_map[".dsp"] = "text/plain"
            elif path.endswith(".webmanifest"):
                self.extensions_map[".webmanifest"] = "application/manifest+json"
            super().do_GET()

    def _query_id(self):
        if "?" not in self.path:
            return ""
        for item in self.path.split("?", 1)[1].split("&"):
            if item.startswith("id="):
                return item.split("=", 1)[1]
        return ""

    def _send_settings(self):
        preset_id = self._query_id()
        with settings_lock:
            if preset_id:
                stored = None
                for preset in settings_library.get("presets") or []:
                    if str(preset.get("id")) == preset_id:
                        stored = preset.get("config")
                        break
            else:
                stored = _library_summary(settings_library)
        if preset_id and not _valid_preset_id(preset_id):
            self.send_error(400)
            return
        if preset_id and stored is None:
            payload = b'{"saved":false}'
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        self._json(stored)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/settings":
            self.send_error(405)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            self.send_error(411)
            return
        if length == 0:
            error, summary = _activate_preset(self._query_id())
            if error == "invalid":
                self.send_error(400)
                return
            if error == "missing":
                self.send_error(404)
                return
            self._json(summary)
            return
        if length > SETTINGS_MAX_BYTES:
            self.send_error(413)
            return
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            self.send_error(400)
            return
        error, preset_id, summary = _save_preset(parsed)
        if error == "invalid":
            self.send_error(400)
            return
        if error == "full":
            self.send_error(507)
            return
        if error:
            self.send_error(507)
            return
        summary["ok"] = True
        summary["id"] = preset_id
        self._json(summary)

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path != "/api/settings":
            self.send_error(405)
            return
        error, summary = _delete_preset(self._query_id())
        if error == "invalid":
            self.send_error(400)
            return
        if error == "missing":
            payload = json.dumps(summary).encode()
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        self._json(summary)

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"retry: 1500\n\n")
        self.wfile.flush()

        after = self._query_int("after", -1)
        sequence = max(0, sensor.sequence - STREAM_PRIME_POINTS) if after < 0 else after
        limit = STREAM_PRIME_POINTS
        idle = 0.0
        try:
            while True:
                newest, intervals = sensor.snapshot(sequence, limit)
                limit = STREAM_BATCH
                if intervals:
                    sequence = newest
                    idle = 0.0
                elif idle < KEEPALIVE_S:
                    idle += STREAM_INTERVAL_S
                    time.sleep(STREAM_INTERVAL_S)
                    continue
                else:
                    idle = 0.0
                payload = json.dumps(
                    {"seq": sequence, "intervals_us": intervals, "dropped": sensor.dropped}
                )
                self.wfile.write(("id: %d\ndata: %s\n\n" % (sequence, payload)).encode())
                self.wfile.flush()
                time.sleep(STREAM_INTERVAL_S)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--replay", help="fichier JSON exporté par le datalogger")
    args = parser.parse_args()
    if args.replay:
        sensor = ReplaySensor(args.replay)
        print("Rejoue %d périodes de %s" % (len(sensor.recorded), args.replay))
    sensor.start()
    print("Interface : http://localhost:%d" % args.port)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
