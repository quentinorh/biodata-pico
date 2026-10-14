"""Vérification hors-cible de la logique pure du firmware (jetable)."""

import ast
from array import array

SOURCE = open("pico_firmware/main.py", encoding="utf-8").read()
tree = ast.parse(SOURCE)
WANTED = {
    "PeriodBuffer",
    "dns_response",
    "blink_half_ms",
    "host_name",
    "is_captive_probe",
    "wants_captive_api",
    "portal_api",
    "portal_page",
}
nodes = [n for n in tree.body if getattr(n, "name", None) in WANTED]
namespace = {
    "array": array,
    "MIN_PERIOD_US": 2000,
    "MAX_PERIOD_US": 250000,
    "TICKS_NUMERATOR": 3_000_000,
    "TICKS_DENOMINATOR": 3_000_000,
}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "main.py", "exec"), namespace)

PeriodBuffer = namespace["PeriodBuffer"]
dns_response = namespace["dns_response"]
blink_half_ms = namespace["blink_half_ms"]
host_name = namespace["host_name"]
is_captive_probe = namespace["is_captive_probe"]
wants_captive_api = namespace["wants_captive_api"]
portal_api = namespace["portal_api"]
portal_page = namespace["portal_page"]

# ── Anneau ──
buf = PeriodBuffer(8)
for ticks in range(20000, 20010):
    buf.add_ticks(ticks)
assert buf.sequence == 10, buf.sequence
assert buf.dropped == 0

cursor, points = buf.snapshot(0, 100)
assert cursor == 10
assert points == list(range(20002, 20010)), points  # les 8 plus récents

cursor2, points2 = buf.snapshot(cursor, 100)
assert cursor2 == 10 and points2 == [], (cursor2, points2)

buf.add_ticks(20500)
cursor3, points3 = buf.snapshot(cursor2, 100)
assert cursor3 == 11 and points3 == [20500], (cursor3, points3)

# Limite : on garde les mesures les plus récentes
for ticks in range(21000, 21006):
    buf.add_ticks(ticks)
cursor4, points4 = buf.snapshot(cursor3, 3)
assert points4 == [21003, 21004, 21005], points4
assert cursor4 == 17

# Hors bornes de plausibilité
buf.add_ticks(10)
buf.add_ticks(9_000_000)
assert buf.dropped == 2, buf.dropped
assert buf.sequence == 17

# Bascule d'index sur un tour complet
buf2 = PeriodBuffer(4)
for ticks in range(20000, 20006):
    buf2.add_ticks(ticks)
assert buf2.snapshot(0, 4)[1] == [20002, 20003, 20004, 20005]
assert buf2.snapshot(4, 4)[1] == [20004, 20005]

# ── DNS ──
def query(name, qtype=b"\x00\x01"):
    labels = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    return b"\xab\xcd\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00" + labels + qtype + b"\x00\x01"


ip = bytes((192, 168, 4, 1))
reply = dns_response(query("connectivitycheck.gstatic.com"), ip)
assert reply[0:2] == b"\xab\xcd"  # même identifiant
assert reply[2:4] == b"\x85\x80"  # réponse autoritaire
assert reply[4:6] == b"\x00\x01" and reply[6:8] == b"\x00\x01"  # 1 question, 1 réponse
assert reply.endswith(b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + ip)
assert reply[12:12 + 34] == query("connectivitycheck.gstatic.com")[12:12 + 34]

aaaa = dns_response(query("captive.apple.com", b"\x00\x1c"), ip)
assert aaaa[6:8] == b"\x00\x00", "AAAA doit rester sans réponse"

assert dns_response(b"\x00" * 4, ip) is None
assert dns_response(b"\xab\xcd\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x03abc", ip) is None
echo = bytearray(query("connectivitycheck.gstatic.com"))
echo[2] |= 0x80
assert dns_response(bytes(echo), ip) is None

# ── Portail : sonde Android = page, pas un 204 ──
ap = "192.168.4.1"
url = "http://%s/" % ap
assert is_captive_probe("connectivitycheck.gstatic.com", "/generate_204", ap)
assert is_captive_probe("connectivitycheck.gstatic.com:80", "/gen_204", ap)
assert is_captive_probe("www.google.com.", "/generate_204?x=1", ap)
assert is_captive_probe("captive.apple.com", "/hotspot-detect.html", ap)
assert is_captive_probe("www.msftconnecttest.com", "/connecttest.txt", ap)
assert is_captive_probe(ap, "/generate_204", ap)
assert is_captive_probe("192.168.4.1:80", "/", ap) is False
assert is_captive_probe(ap, "/api/stream", ap) is False
assert is_captive_probe("", "/index.html", ap) is False
assert is_captive_probe("neverssl.com", "/", ap)
assert host_name(" ConnectivityCheck.Gstatic.com:80.") == "connectivitycheck.gstatic.com"

page = portal_page(url)
assert url in page and len(page) > 80
assert "Success</TITLE>" not in page
assert "Microsoft Connect Test" not in page
assert wants_captive_api("text/html, application/captive+json")
assert wants_captive_api("text/html") is False
api = portal_api(url)
assert '"captive":true' in api and url in api

# ── LED : demi-période proportionnelle au débit ──
# 12 impulsions en 250 ms ≈ 48/s, 10 impulsions par clignotement → ~104 ms
assert blink_half_ms(12, 250, 10, 20, 1000) == 104
assert blink_half_ms(0, 250, 10, 20, 1000) == 0
assert blink_half_ms(12, 0, 10, 20, 1000) == 0
# Trop rapide : plancher à 20 ms (25 Hz).
assert blink_half_ms(100, 250, 10, 20, 1000) == 20
# Trop lent : plafond à 1 s de demi-période.
assert blink_half_ms(1, 250, 10, 20, 1000) == 1000

print("logique firmware ok")
