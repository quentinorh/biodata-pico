"""BioSonification pour Raspberry Pi Pico 2 W (MicroPython).

Le Pico ouvre son propre point d'accès Wi-Fi, sert l'interface web du dossier
``app`` et diffuse en Server-Sent Events les périodes mesurées par la PIO sur
la sortie impulsionnelle du capteur.
"""

import gc
import os
import socket
import time
from array import array

import network
import rp2
import uasyncio as asyncio
import ujson
from machine import Pin

import config

MIN_PERIOD_US = config.MIN_PERIOD_US
MAX_PERIOD_US = config.MAX_PERIOD_US
# Le compteur PIO consomme trois cycles par pas : à 3 MHz, un pas vaut 1 µs.
TICKS_NUMERATOR = 3_000_000
TICKS_DENOMINATOR = config.PIO_FREQUENCY_HZ


@rp2.asm_pio()
def pulse_period():
    # Synchronisation initiale sur un front montant.
    wait(0, pin, 0)
    wait(1, pin, 0)

    wrap_target()
    # x décroît à chaque pas ; il est inversé à la fin pour obtenir le compte.
    set(x, 0)

    label("high")  # trois cycles par pas tant que l'entrée est haute
    jmp(x_dec, "high_tick")
    label("high_tick")
    nop()
    jmp(pin, "high")

    label("low")  # trois cycles par pas tant que l'entrée est basse
    jmp(x_dec, "low_tick")
    label("low_tick")
    jmp(pin, "emit")
    jmp("low")

    label("emit")  # front montant suivant : la période est complète
    mov(isr, invert(x))
    push(noblock)
    irq(rel(0))
    wrap()


class PeriodBuffer:
    """Anneau de périodes en microsecondes, alimenté par l'IRQ de la PIO."""

    def __init__(self, size):
        self.size = size
        self.periods = array("I", bytes(4 * size))
        self.write_index = 0
        self.sequence = 0
        self.dropped = 0
        self.last_period = 0

    def add_ticks(self, ticks):
        period_us = (ticks * TICKS_NUMERATOR) // TICKS_DENOMINATOR
        if period_us < MIN_PERIOD_US or period_us > MAX_PERIOD_US:
            self.dropped += 1
            return
        index = self.write_index
        self.periods[index] = period_us
        self.last_period = period_us
        self.write_index = index + 1 if index + 1 < self.size else 0
        self.sequence += 1

    def snapshot(self, after_sequence, limit):
        """Retourne (curseur, périodes) pour tout ce qui suit after_sequence."""
        newest = self.sequence
        available = newest - after_sequence
        if available <= 0:
            return newest, []
        if available > self.size:
            available = self.size
        if available > limit:
            available = limit
        periods = self.periods
        index = (newest - available) % self.size
        points = []
        for _ in range(available):
            points.append(periods[index])
            index = index + 1 if index + 1 < self.size else 0
        return newest, points


def blink_half_ms(pulse_count, elapsed_ms, pulses_per_blink, min_half_ms, max_half_ms):
    """Demi-période de la LED pour un débit d'impulsions. 0 = éteinte."""
    if pulse_count <= 0 or elapsed_ms <= 0 or pulses_per_blink <= 0:
        return 0
    half = (elapsed_ms * pulses_per_blink) // (2 * pulse_count)
    if half < min_half_ms:
        return min_half_ms
    if half > max_half_ms:
        return max_half_ms
    return half


sensor = PeriodBuffer(config.RING_SIZE)
sensor_sm = None
library_cache = None
stream_clients = 0
access_point_ip = "192.168.4.1"


def on_pio_data(state_machine):
    # Uniquement de l'arithmétique entière : rien n'alloue dans l'IRQ.
    while state_machine.rx_fifo():
        sensor.add_ticks(state_machine.get())


def start_sensor():
    global sensor_sm
    pin = Pin(config.SENSOR_PIN, Pin.IN, Pin.PULL_DOWN)
    state_machine = rp2.StateMachine(
        0,
        pulse_period,
        freq=config.PIO_FREQUENCY_HZ,
        in_base=pin,
        jmp_pin=pin,
    )
    state_machine.irq(on_pio_data)
    state_machine.active(1)
    sensor_sm = state_machine
    return state_machine


def _set_wifi_country():
    try:
        rp2.country(config.WIFI_COUNTRY)
    except Exception:
        pass
    try:
        network.country(config.WIFI_COUNTRY)
    except Exception:
        pass


def _disable_station():
    try:
        station = network.WLAN(network.STA_IF)
        station.active(False)
    except Exception:
        pass


def _configure_access_point(access_point):
    if config.WIFI_OPEN:
        security = getattr(network, "AUTH_OPEN", 0)
        attempts = (
            {
                "ssid": config.WIFI_SSID,
                "security": security,
                "channel": config.WIFI_CHANNEL,
                "max_clients": config.WIFI_MAX_CLIENTS,
            },
            {"ssid": config.WIFI_SSID, "security": security},
            {"essid": config.WIFI_SSID, "security": security},
        )
    else:
        security = getattr(network, "AUTH_WPA2_PSK", 3)
        attempts = (
            {
                "ssid": config.WIFI_SSID,
                "key": config.WIFI_PASSWORD,
                "security": security,
                "channel": config.WIFI_CHANNEL,
                "max_clients": config.WIFI_MAX_CLIENTS,
            },
            {
                "ssid": config.WIFI_SSID,
                "password": config.WIFI_PASSWORD,
                "channel": config.WIFI_CHANNEL,
            },
            {"essid": config.WIFI_SSID, "password": config.WIFI_PASSWORD},
            {"ssid": config.WIFI_SSID, "key": config.WIFI_PASSWORD},
        )
    for settings in attempts:
        try:
            access_point.config(**settings)
            return
        except (AttributeError, OSError, TypeError, ValueError):
            pass
    print("SSID du point d'accès non configuré")


def _disable_wifi_power_save(access_point):
    try:
        access_point.config(pm=network.WLAN.PM_NONE)
        return
    except (AttributeError, OSError, ValueError):
        pass
    try:
        access_point.config(pm=0)
    except (AttributeError, OSError, ValueError):
        pass


def start_access_point():
    global access_point_ip
    _set_wifi_country()
    _disable_station()
    access_point = network.WLAN(network.AP_IF)
    access_point.active(False)
    _configure_access_point(access_point)
    access_point.active(True)
    while not access_point.active():
        pass
    _configure_access_point(access_point)
    _disable_wifi_power_save(access_point)
    access_point_ip = access_point.ifconfig()[0]
    if config.WIFI_OPEN:
        print("Point d'accès ouvert :", config.WIFI_SSID)
    else:
        print("Point d'accès :", config.WIFI_SSID)
    print("Interface web : http://%s" % access_point_ip)
    return access_point


# ─── Portail captif ───


def dns_query(request):
    """Nom demandé et section question, ou None si le paquet est inutilisable."""
    if len(request) < 13 or request[2] & 0x80:
        return None
    index = 12
    labels = []
    while index < len(request):
        length = request[index]
        if length == 0:
            index += 1
            break
        # Un pointeur de compression ne se copie pas comme un nom simple.
        if length & 0xC0 or index + 1 + length > len(request) or len(labels) > 32:
            return None
        labels.append(request[index + 1 : index + 1 + length])
        index += 1 + length
    else:
        return None
    if index + 4 > len(request):
        return None
    try:
        name = b".".join(labels).decode()
    except UnicodeError:
        name = "?"
    return name, request[12 : index + 4]


def dns_response(request, address_bytes):
    """Répond à toute requête par l'adresse du Pico, y compris AAAA."""
    parsed = dns_query(request)
    if parsed is None:
        return None
    _name, question = parsed
    return (
        request[0:2]
        + b"\x85\x80"
        + request[4:6]  # une question
        + b"\x00\x01\x00\x00\x00\x00"  # une réponse A, rien d'autre
        + question
        + b"\xc0\x0c"  # pointeur vers le nom de la question
        + b"\x00\x01\x00\x01"  # type A, classe IN
        + b"\x00\x00\x00\x3c"  # TTL 60 s
        + b"\x00\x04"
        + address_bytes
    )


async def run_captive_dns():
    address_bytes = bytes(int(part) for part in access_point_ip.split("."))
    try:
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        udp.setblocking(False)
        udp.bind(("0.0.0.0", 53))
    except OSError as error:
        # Sans DNS, l'interface reste accessible en tapant l'adresse du Pico.
        print("Portail captif indisponible :", error)
        return
    print("DNS captif :", access_point_ip)
    while True:
        waiting = True
        while True:
            try:
                request, client = udp.recvfrom(512)
            except OSError:
                break
            waiting = False
            try:
                parsed = dns_query(request)
                response = dns_response(request, address_bytes)
                if parsed and response:
                    print("DNS", parsed[0])
                    udp.sendto(response, client)
            except OSError:
                pass
        await asyncio.sleep_ms(20 if waiting else 0)


# ─── Serveur HTTP ───

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".dsp": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".webmanifest": "application/manifest+json",
}


def content_type(path):
    if path.endswith(".gz"):
        path = path[:-3]
    for suffix, mime in CONTENT_TYPES.items():
        if path.endswith(suffix):
            return mime
    return "application/octet-stream"


def file_size(path):
    try:
        return os.stat(path)[6]
    except OSError:
        return None


async def send_response(writer, status, mime, body, extra_headers=""):
    if isinstance(body, str):
        body = body.encode()
    header = (
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n%s\r\n"
    ) % (status, mime, len(body), extra_headers)
    writer.write(header.encode())
    await writer.drain()
    offset = 0
    total = len(body)
    while offset < total:
        end = offset + 512 if offset + 512 < total else total
        writer.write(body[offset:end])
        await writer.drain()
        offset = end


def host_name(host):
    """Nom d'hôte sans port ni point final."""
    if not host:
        return ""
    host = host.strip().lower().rstrip(".")
    if host.startswith("["):
        end = host.find("]")
        return host[: end + 1] if end > 0 else host
    return host.split(":")[0]


def captive_kind(host, path, ap_ip):
    """page, text, redirect, ou None si la requête vise l'interface elle-même.

    Android et Apple n'ouvrent la feuille que devant un 200 HTML.
    Windows n'ouvre le navigateur que si connecttest.txt n'est pas le
    texte attendu, puis que /redirect est une redirection.
    """
    path = path.split("?", 1)[0]
    if path in (
        "/generate_204",
        "/gen_204",
        "/generate204",
        "/hotspot-detect.html",
        "/library/test/success.html",
        "/kindle-wifi/wifistub.html",
    ):
        return "page"
    if path in ("/connecttest.txt", "/ncsi.txt", "/success.txt"):
        return "text"
    if path == "/redirect" or path == "/canonical.html" or path.startswith("/fwlink"):
        return "redirect"
    if host_name(host) not in ("", ap_ip, "localhost", "127.0.0.1"):
        return "redirect"
    return None


def wants_captive_api(accept):
    return bool(accept) and "application/captive+json" in accept.lower()


def portal_api(url):
    """API de portail (RFC 8908) : Android s'en sert pour le bouton de la page."""
    return '{"captive":true,"user-portal-url":"%s"}' % url


def portal_page(url):
    """Page courte, sans script : la fenêtre captive des téléphones n'en exécute pas."""
    return (
        "<!DOCTYPE html><html><head><meta charset=utf-8>"
        '<meta name=viewport content="width=device-width,initial-scale=1">'
        '<meta http-equiv=refresh content="0;url=%s">'
        "<title>Plante musicale</title></head><body>"
        '<p><a href="%s">Ouvrir l\'interface</a></p>'
        "</body></html>"
    ) % (url, url)


async def send_redirect(writer):
    """Renvoie une adresse inconnue vers l'interface."""
    location = "http://%s/" % access_point_ip
    await send_response(
        writer,
        "302 Found",
        "text/html; charset=utf-8",
        '<a href="%s">Interface BioSonification</a>' % location,
        "Location: %s\r\n" % location,
    )


async def send_captive(writer, kind, accept):
    """Réponse adaptée à la sonde. Un 204 ferait croire que l'accès internet marche."""
    url = "http://%s/" % access_point_ip
    if wants_captive_api(accept):
        await send_response(
            writer, "200 OK", "application/captive+json", portal_api(url)
        )
        return
    if kind == "text":
        # Ni « Microsoft Connect Test », ni « Microsoft NCSI ».
        await send_response(writer, "200 OK", "text/plain", "plante")
        return
    if kind == "page":
        await send_response(
            writer, "200 OK", "text/html; charset=utf-8", portal_page(url)
        )
        return
    await send_redirect(writer)


def static_path(path):
    if path.endswith("/"):
        path += "index.html"
    if ".." in path:
        return None
    return config.STATIC_DIR + path


async def send_file(writer, path):
    """Sert un fichier, en préférant une version .gz si elle a été déposée."""
    encoding = ""
    size = file_size(path + ".gz")
    if size is None:
        size = file_size(path)
    else:
        encoding = "Content-Encoding: gzip\r\n"
        path += ".gz"
    if size is None:
        return False
    header = (
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n%s\r\n"
    ) % (content_type(path), size, encoding)
    writer.write(header.encode())
    await writer.drain()
    with open(path, "rb") as source:
        while True:
            chunk = source.read(1024)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    return True


def parse_query(path):
    if "?" not in path:
        return path, {}
    path, raw_query = path.split("?", 1)
    query = {}
    for item in raw_query.split("&"):
        if "=" in item:
            key, value = item.split("=", 1)
            query[key] = value
    return path, query


def query_int(query, key, default):
    try:
        return int(query.get(key, default))
    except ValueError:
        return default


def sensor_payload(sequence, intervals):
    return ujson.dumps(
        {
            "seq": sequence,
            "intervals_us": intervals,
            "dropped": sensor.dropped,
        }
    )


def _read_settings_file(path):
    try:
        with open(path, "rb") as handle:
            data = handle.read(config.SETTINGS_MAX_BYTES + 1)
    except OSError:
        return None
    if not data or len(data) > config.SETTINGS_MAX_BYTES:
        return None
    return data


def _write_settings_file(payload):
    temporary = config.SETTINGS_PATH + ".tmp"
    try:
        with open(temporary, "wb") as handle:
            handle.write(payload)
    except OSError:
        return False
    try:
        os.remove(config.SETTINGS_PATH)
    except OSError:
        pass
    try:
        os.rename(temporary, config.SETTINGS_PATH)
    except OSError:
        return False
    return True


def _valid_preset_id(value):
    if isinstance(value, int):
        return value > 0
    if not isinstance(value, str) or not value or len(value) > 8:
        return False
    for char in value:
        if char < "0" or char > "9":
            return False
    return True


def _preset_title(raw):
    if not isinstance(raw, str):
        return "Sans titre"
    text = raw.strip()
    if not text:
        return "Sans titre"
    return text[:80]


def _blank_library():
    return {"v": 1, "active": "", "next": 1, "presets": []}


def _migrate_library(parsed):
    """Ancien fichier unique : un seul jeu, devenu la première entrée."""
    presets = parsed.get("presets")
    if isinstance(presets, list):
        return parsed
    if parsed.get("app") != "plante-musicale":
        return _blank_library()
    title = _preset_title(parsed.get("title"))
    parsed["title"] = title
    return {
        "v": 1,
        "active": "1",
        "next": 2,
        "presets": [{"id": "1", "title": title, "config": parsed}],
    }


def load_library():
    global library_cache
    if library_cache is not None:
        return library_cache
    for path in (config.SETTINGS_PATH, config.SETTINGS_PATH + ".tmp"):
        data = _read_settings_file(path)
        if data is None:
            continue
        try:
            parsed = ujson.loads(data.decode())
        except (UnicodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            library_cache = _migrate_library(parsed)
            return library_cache
    library_cache = _blank_library()
    return library_cache


def library_summary(library):
    items = []
    for preset in library.get("presets") or []:
        if not isinstance(preset, dict):
            continue
        raw_id = preset.get("id")
        if not _valid_preset_id(raw_id):
            continue
        items.append({"id": str(raw_id), "title": preset.get("title") or "Sans titre"})
    active = library.get("active")
    return {
        "active": str(active) if _valid_preset_id(active) else "",
        "presets": items,
    }


def preset_config(library, preset_id):
    wanted = str(preset_id)
    for preset in library.get("presets") or []:
        if isinstance(preset, dict) and str(preset.get("id", "")) == wanted:
            config_obj = preset.get("config")
            if isinstance(config_obj, dict):
                return config_obj
    return None


def store_library(library):
    # LittleFS suspend les interruptions pendant l'effacement d'un bloc :
    # couper la PIO un instant évite une pile d'IRQ au milieu de la réponse.
    was_active = bool(sensor_sm and sensor_sm.active())
    if was_active:
        sensor_sm.active(0)
    try:
        gc.collect()
        payload = ujson.dumps(library).encode()
        if len(payload) > config.SETTINGS_MAX_BYTES:
            return "too_large"
        if not _write_settings_file(payload):
            return "store"
        return None
    finally:
        if was_active:
            sensor_sm.active(1)


def save_preset(parsed):
    """Prépare un jeu en mémoire. L'écriture en flash suit la réponse HTTP."""
    if not isinstance(parsed, dict) or parsed.get("app") != "plante-musicale":
        return "invalid", "", None
    if len(ujson.dumps(parsed)) > config.SETTINGS_MAX_BYTES:
        return "too_large", "", None
    library = load_library()
    title = _preset_title(parsed.get("title"))
    parsed["title"] = title
    wanted = parsed.pop("id", None)
    presets = library.setdefault("presets", [])
    found = None
    if _valid_preset_id(wanted):
        wanted_str = str(wanted)
        for preset in presets:
            if isinstance(preset, dict) and str(preset.get("id", "")) == wanted_str:
                found = preset
                break
    if found is None:
        if len(presets) >= config.SETTINGS_MAX_PRESETS:
            return "full", "", None
        try:
            next_id = int(library.get("next") or 1)
        except (TypeError, ValueError):
            next_id = 1
        if next_id < 1:
            next_id = 1
        preset_id = str(next_id)
        if len(ujson.dumps(library)) + len(ujson.dumps(parsed)) + 128 > config.SETTINGS_MAX_BYTES:
            return "too_large", "", None
        library["next"] = next_id + 1
        found = {"id": preset_id, "title": title, "config": parsed}
        presets.insert(0, found)
    else:
        preset_id = str(found["id"])
        found["id"] = preset_id
        found["title"] = title
        found["config"] = parsed
        if len(ujson.dumps(library)) > config.SETTINGS_MAX_BYTES:
            return "too_large", "", None
    library["active"] = preset_id
    return None, preset_id, library_summary(library)


def activate_preset(preset_id):
    if not _valid_preset_id(preset_id):
        return "invalid", None
    preset_id = str(preset_id)
    library = load_library()
    if preset_config(library, preset_id) is None:
        return "missing", library_summary(library)
    library["active"] = preset_id
    return None, library_summary(library)


def delete_preset(preset_id):
    if not _valid_preset_id(preset_id):
        return "invalid", None
    preset_id = str(preset_id)
    library = load_library()
    presets = library.get("presets") or []
    kept = []
    removed = False
    for preset in presets:
        if isinstance(preset, dict) and str(preset.get("id", "")) == preset_id:
            removed = True
            continue
        kept.append(preset)
    if not removed:
        return "missing", library_summary(library)
    library["presets"] = kept
    if str(library.get("active", "")) == preset_id:
        library["active"] = ""
    return None, library_summary(library)


async def read_exact(reader, count):
    """Lit count octets. Un read() vide n'est pas toujours une fin de connexion."""
    if count <= 0:
        return b""
    parts = []
    left = count
    misses = 0
    while left > 0 and misses < 40:
        chunk = await reader.read(1024 if left > 1024 else left)
        if not chunk:
            misses += 1
            await asyncio.sleep_ms(25)
            continue
        misses = 0
        parts.append(chunk)
        left -= len(chunk)
    if left > 0:
        return None
    return b"".join(parts)


async def read_chunked(reader, limit):
    """Corps HTTP découpé, utilisé par certains téléphones à la place de Content-Length."""
    body = bytearray()
    while True:
        line = await reader.readline()
        if not line:
            return None
        size_text = line.strip().split(b";", 1)[0]
        try:
            size = int(size_text or b"0", 16)
        except ValueError:
            return None
        if size < 0:
            return None
        if size == 0:
            while True:
                trailer = await reader.readline()
                if trailer in (b"\r\n", b"\n", b""):
                    break
            return bytes(body)
        if len(body) + size > limit:
            return None
        chunk = await read_exact(reader, size)
        if chunk is None:
            return None
        body.extend(chunk)
        await reader.readline()


async def read_request_body(reader, content_length, transfer_encoding):
    if transfer_encoding and "chunked" in transfer_encoding:
        return await read_chunked(reader, config.SETTINGS_MAX_BYTES)
    if content_length > config.SETTINGS_MAX_BYTES:
        return None
    if content_length >= 0:
        return await read_exact(reader, content_length)
    # Ni longueur ni découpage : lire ce qui arrive, puis s'arrêter.
    parts = []
    total = 0
    misses = 0
    while misses < 8 and total <= config.SETTINGS_MAX_BYTES:
        chunk = await reader.read(1024)
        if not chunk:
            misses += 1
            await asyncio.sleep_ms(25)
            continue
        misses = 0
        total += len(chunk)
        parts.append(chunk)
    if total > config.SETTINGS_MAX_BYTES:
        return None
    return b"".join(parts)


async def send_sensor_stream(writer, after):
    """Flux SSE : l'interface web consomme ces messages via EventSource."""
    global stream_clients
    if stream_clients >= config.MAX_STREAM_CLIENTS:
        await send_response(
            writer, "503 Service Unavailable", "text/plain", "Flux occupe"
        )
        return
    stream_clients += 1
    try:
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            b"Content-Type: text/event-stream\r\n"
            b"Cache-Control: no-store\r\n"
            b"Connection: keep-alive\r\n\r\n"
            b"retry: 1500\n\n"
        )
        await writer.drain()
        if after < 0:
            after = max(0, sensor.sequence - config.STREAM_PRIME_POINTS)
        sequence = after
        idle_ms = 0
        keepalive_ms = config.STREAM_IDLE_KEEPALIVE_MS
        # Le premier envoi est plus gros : il remplit le graphe d'un coup.
        limit = config.STREAM_PRIME_POINTS
        while True:
            newest, intervals = sensor.snapshot(sequence, limit)
            limit = config.STREAM_BATCH
            if intervals:
                sequence = newest
                idle_ms = 0
            elif idle_ms < keepalive_ms:
                idle_ms += config.STREAM_INTERVAL_MS
                await asyncio.sleep_ms(config.STREAM_INTERVAL_MS)
                continue
            else:
                # Message vide : le navigateur voit que le Pico est vivant.
                idle_ms = 0
            payload = sensor_payload(sequence, intervals)
            writer.write(("id: %d\ndata: %s\n\n" % (sequence, payload)).encode())
            await writer.drain()
            await asyncio.sleep_ms(config.STREAM_INTERVAL_MS)
    finally:
        stream_clients -= 1


async def handle_client(reader, writer):
    try:
        request_line = await reader.readline()
        if not request_line:
            return
        parts = request_line.decode().split()
        if len(parts) < 2:
            return
        method, raw_path = parts[0], parts[1]

        last_event_id = -1
        host = ""
        accept = ""
        content_length = -1
        transfer_encoding = ""
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            lower = line.lower()
            if lower.startswith(b"host:"):
                try:
                    host = line.split(b":", 1)[1].strip().decode()
                except UnicodeError:
                    host = ""
            elif lower.startswith(b"accept:"):
                try:
                    accept = line.split(b":", 1)[1].strip().decode()
                except UnicodeError:
                    accept = ""
            elif lower.startswith(b"content-length:"):
                try:
                    content_length = int(line.split(b":", 1)[1].strip())
                except (IndexError, ValueError):
                    content_length = -1
            elif lower.startswith(b"transfer-encoding:"):
                try:
                    transfer_encoding = line.split(b":", 1)[1].strip().decode().lower()
                except UnicodeError:
                    transfer_encoding = ""
            elif lower.startswith(b"last-event-id:"):
                try:
                    last_event_id = int(line.split(b":", 1)[1].strip())
                except (IndexError, ValueError):
                    pass

        path, query = parse_query(raw_path)
        kind = captive_kind(host, path, access_point_ip)
        if kind:
            print("Sonde %s %s %s" % (kind, host_name(host) or "-", path.split("?", 1)[0]))
            await send_captive(writer, kind, accept)
        elif path == "/api/settings" and method == "GET":
            library = load_library()
            preset_id = query.get("id", "")
            if preset_id:
                if not _valid_preset_id(preset_id):
                    await send_response(
                        writer, "400 Bad Request", "text/plain", "Identifiant invalide"
                    )
                else:
                    stored = preset_config(library, preset_id)
                    if stored is None:
                        await send_response(
                            writer, "404 Not Found", "application/json", '{"saved":false}'
                        )
                    else:
                        await send_response(
                            writer, "200 OK", "application/json", ujson.dumps(stored)
                        )
            else:
                await send_response(
                    writer, "200 OK", "application/json", ujson.dumps(library_summary(library))
                )
        elif path == "/api/settings" and method == "DELETE":
            error, summary = delete_preset(query.get("id", ""))
            if error == "invalid":
                await send_response(
                    writer, "400 Bad Request", "text/plain", "Identifiant invalide"
                )
            elif error == "missing":
                await send_response(
                    writer, "404 Not Found", "application/json", ujson.dumps(summary)
                )
            else:
                await send_response(
                    writer, "200 OK", "application/json", ujson.dumps(summary)
                )
                store_library(load_library())
        elif path == "/api/settings" and method == "POST" and content_length == 0:
            error, summary = activate_preset(query.get("id", ""))
            if error == "invalid":
                await send_response(
                    writer, "400 Bad Request", "text/plain", "Identifiant invalide"
                )
            elif error == "missing":
                await send_response(
                    writer, "404 Not Found", "application/json", ujson.dumps(summary)
                )
            else:
                await send_response(
                    writer, "200 OK", "application/json", ujson.dumps(summary)
                )
        elif path == "/api/settings" and method == "POST":
            # Lire le corps avant toute réponse : sinon le téléphone voit une
            # coupure et croit que le Pico est injoignable.
            too_big = (
                not transfer_encoding
                and content_length > config.SETTINGS_MAX_BYTES
            )
            payload = b"" if content_length == 0 and not transfer_encoding else None
            if payload is None and not too_big:
                payload = await read_request_body(
                    reader, content_length, transfer_encoding
                )
            if too_big or (payload is not None and len(payload) > config.SETTINGS_MAX_BYTES):
                await send_response(
                    writer,
                    "413 Payload Too Large",
                    "text/plain",
                    "Réglages trop volumineux",
                )
            elif content_length == 0 and not payload:
                error, summary = activate_preset(query.get("id", ""))
                if error == "invalid":
                    await send_response(
                        writer, "400 Bad Request", "text/plain", "Identifiant invalide"
                    )
                elif error == "missing":
                    await send_response(
                        writer, "404 Not Found", "application/json", ujson.dumps(summary or {})
                    )
                else:
                    await send_response(
                        writer, "200 OK", "application/json", ujson.dumps(summary)
                    )
            elif not payload:
                await send_response(
                    writer, "400 Bad Request", "text/plain", "Corps manquant"
                )
            else:
                try:
                    parsed = ujson.loads(payload.decode())
                except (UnicodeError, ValueError):
                    parsed = None
                try:
                    error, preset_id, summary = save_preset(
                        parsed if isinstance(parsed, dict) else {}
                    )
                except Exception as error:
                    print("Erreur reglages :", error)
                    error, preset_id, summary = "store", "", None
                if error == "invalid":
                    await send_response(
                        writer, "400 Bad Request", "text/plain", "JSON invalide"
                    )
                elif error == "too_large":
                    await send_response(
                        writer,
                        "413 Payload Too Large",
                        "text/plain",
                        "Réglages trop volumineux",
                    )
                elif error == "full":
                    await send_response(
                        writer, "507 Insufficient Storage", "text/plain", "Liste pleine"
                    )
                elif error:
                    await send_response(
                        writer,
                        "507 Insufficient Storage",
                        "text/plain",
                        "Enregistrement impossible",
                    )
                else:
                    summary["ok"] = True
                    summary["id"] = preset_id
                    await send_response(
                        writer, "200 OK", "application/json", ujson.dumps(summary)
                    )
                    store_library(load_library())
        elif method not in ("GET", "HEAD"):
            await send_response(
                writer, "405 Method Not Allowed", "text/plain", "GET uniquement"
            )
        elif path == "/api/stream":
            after = query_int(query, "after", last_event_id)
            await send_sensor_stream(writer, after)
        elif path == "/api/data":
            sequence, intervals = sensor.snapshot(
                query_int(query, "after", 0), config.MAX_POINTS_PER_RESPONSE
            )
            await send_response(
                writer, "200 OK", "application/json", sensor_payload(sequence, intervals)
            )
        elif path == "/api/status":
            payload = ujson.dumps(
                {
                    "ssid": config.WIFI_SSID,
                    "ip": access_point_ip,
                    "sensor_pin": config.SENSOR_PIN,
                    "period_us": sensor.last_period,
                    "samples": sensor.sequence,
                    "dropped": sensor.dropped,
                    "clients": stream_clients,
                    "free_ram": gc.mem_free(),
                }
            )
            await send_response(writer, "200 OK", "application/json", payload)
        elif path == "/favicon.ico":
            target = static_path(path)
            if target is None or not await send_file(writer, target):
                await send_response(writer, "204 No Content", "image/x-icon", b"")
        else:
            target = static_path(path)
            if target is None or not await send_file(writer, target):
                await send_redirect(writer)
    except Exception as error:
        print("Erreur HTTP :", error)
    finally:
        try:
            writer.close()
        except Exception:
            pass
        try:
            await writer.wait_closed()
        except Exception:
            pass
        gc.collect()


async def run_signal_led():
    """Clignote d'autant plus vite que le capteur produit d'impulsions."""
    try:
        led = Pin("LED", Pin.OUT)
    except Exception as error:
        print("LED indisponible :", error)
        return
    led.off()
    last_sequence = sensor.sequence
    window_start = time.ticks_ms()
    half_ms = 0
    lit = False
    edge_at = window_start
    while True:
        now = time.ticks_ms()
        elapsed = time.ticks_diff(now, window_start)
        if elapsed >= config.LED_RATE_WINDOW_MS:
            count = sensor.sequence - last_sequence
            half_ms = blink_half_ms(
                count,
                elapsed,
                config.LED_PULSES_PER_BLINK,
                config.LED_MIN_HALF_MS,
                config.LED_MAX_HALF_MS,
            )
            last_sequence = sensor.sequence
            window_start = now
            if half_ms == 0:
                if lit:
                    lit = False
                    led.off()
            elif not lit:
                lit = True
                led.on()
                edge_at = time.ticks_add(now, half_ms)
        if half_ms == 0:
            remaining = config.LED_RATE_WINDOW_MS - time.ticks_diff(
                time.ticks_ms(), window_start
            )
            if remaining < 1:
                remaining = 1
            await asyncio.sleep_ms(remaining)
            continue
        if time.ticks_diff(now, edge_at) >= 0:
            lit = not lit
            led.value(lit)
            edge_at = time.ticks_add(now, half_ms)
        wait = time.ticks_diff(edge_at, time.ticks_ms())
        if wait < 1:
            wait = 1
        elif wait > 40:
            wait = 40
        await asyncio.sleep_ms(wait)


async def main():
    start_access_point()
    state_machine = start_sensor()
    dns_task = asyncio.create_task(run_captive_dns())
    led_task = asyncio.create_task(run_signal_led())
    server = await asyncio.start_server(handle_client, "0.0.0.0", 80)
    print("Capteur impulsionnel sur GP%d" % config.SENSOR_PIN)
    try:
        while True:
            await asyncio.sleep(5)
            gc.collect()
    finally:
        dns_task.cancel()
        led_task.cancel()
        state_machine.active(0)
        server.close()
        await server.wait_closed()


try:
    asyncio.run(main())
finally:
    asyncio.new_event_loop()
