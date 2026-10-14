"""Simulateur de l'API du Pico, pour travailler l'interface sans matériel.

Sert le dossier ``app`` et reproduit ``/api/stream``, ``/api/data`` et
``/api/status`` avec un signal biodata synthétique à 50 Hz.

    python tools/dev_server.py        puis http://localhost:8080
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


sensor = FakeSensor()


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
        else:
            if path.endswith(".wasm"):
                self.extensions_map[".wasm"] = "application/wasm"
            elif path.endswith(".dsp"):
                self.extensions_map[".dsp"] = "text/plain"
            super().do_GET()

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
    args = parser.parse_args()
    sensor.start()
    print("Interface : http://localhost:%d" % args.port)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
