"""Copie le firmware et l'interface sur un Pico 2 W via mpremote.

Les fichiers de ``app`` sont compressés en gzip : le firmware les sert
ensuite plus vite depuis le point d'accès.

Le Pico W n'a que ~848 Ko de LittleFS, trop juste pour l'interface et les
18 patches. Le Pico 2 W a 4 Mo de flash. Les sources ``.dsp`` restent sur
le PC : les WASM sont résolus via les hashes injectés dans ``catalog.js``.

    python tools/deploy.py
    python tools/deploy.py --port COM16
"""

import argparse
import base64
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE_DIR = os.path.join(ROOT, "pico_firmware")
APP_DIR = os.path.join(ROOT, "app")
STATIC_FILES = (
    "index.html",
    "style.css",
    "script.js",
    "faust-player.js",
    "quantizer.js",
    "default-config.js",
    "inter-var.woff2",
    "sw.js",
    "manifest.webmanifest",
    "favicon.ico",
    "favicon-32.png",
    "apple-touch-icon.png",
    "icon-192.png",
    "icon-512.png",
    "icon-maskable-512.png",
)
FAUST_DIR = os.path.join(APP_DIR, "faust")
FLASH_BLOCK = 4096
# LittleFS alloue une paire de blocs de métadonnées à chaque dossier.
DIR_BLOCKS = 2
FLASH_HEADROOM = 80 * 1024

FORMAT_FS = r"""
import os, vfs, rp2
try:
    os.umount("/")
except OSError:
    pass
bdev = rp2.Flash()
vfs.VfsLfs2.mkfs(bdev)
vfs.mount(bdev, "/")
print("filesystem reformate")
"""

FS_INFO = r"""
import os
s = os.statvfs("/")
print("FS %d %d" % (s[0] * s[2], s[0] * s[3]))
"""

PULL_SETTINGS = r"""
import os, ubinascii
try:
    data = open("settings.json", "rb").read()
except OSError:
    data = b""
encoded = ubinascii.b2a_base64(data).decode().replace("\n", "") if data else ""
print("SETTINGS_B64 " + encoded)
"""


def find_pico_port():
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    for info in list_ports.comports():
        hwid = (info.hwid or "").upper()
        if info.vid == 0x2E8A or "VID:PID=2E8A:" in hwid:
            return info.device
    return None


def run_mpremote(port, args, check=True):
    command = [sys.executable, "-m", "mpremote"]
    if port:
        command.extend(["connect", port])
    command.extend(args)
    print("+", " ".join(command[2:]))
    result = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    text = (result.stdout or "") + (result.stderr or "")
    if text.strip():
        sys.stdout.write(text if text.endswith("\n") else text + "\n")
    if "No space left on device" in text:
        raise SystemExit(
            "Plus d'espace flash sur le Pico. Relancez python tools/deploy.py"
        )
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, command, result.stdout, result.stderr
        )
    return result


def cyrb53(text, seed=0):
    """Hash JS cyrb53, identique à celui de faust-player.js."""
    h1 = (0xDEADBEEF ^ seed) & 0xFFFFFFFF
    h2 = (0x41C6CE57 ^ seed) & 0xFFFFFFFF

    def imul(a, b):
        return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF

    for ch in text:
        code = ord(ch)
        h1 = imul(h1 ^ code, 2654435761)
        h2 = imul(h2 ^ code, 1597334677)
    h1 = imul(h1 ^ (h1 >> 16), 2246822507) ^ imul(h2 ^ (h2 >> 13), 3266489909)
    h2 = imul(h2 ^ (h2 >> 16), 2246822507) ^ imul(h1 ^ (h1 >> 13), 3266489909)
    return 4294967296 * (2097151 & h2) + (h1 & 0xFFFFFFFF)


def write_gzip(data, destination, label):
    compressed = gzip.compress(data, compresslevel=9)
    parent = os.path.dirname(destination)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(destination, "wb") as out:
        out.write(compressed)
    print("gzip %s  %d -> %d octets" % (label, len(data), len(compressed)))


def gzip_file(source, destination):
    write_gzip(open(source, "rb").read(), destination, os.path.basename(source))


def faust_dsp_hashes():
    hashes = {}
    if not os.path.isdir(FAUST_DIR):
        return hashes
    for name in os.listdir(FAUST_DIR):
        patch_dir = os.path.join(FAUST_DIR, name)
        if not os.path.isdir(patch_dir):
            continue
        patch_hashes = {}
        for dirpath, _dirnames, filenames in os.walk(patch_dir):
            for filename in filenames:
                if not filename.endswith(".dsp"):
                    continue
                local = os.path.join(dirpath, filename)
                rel = os.path.relpath(local, patch_dir).replace("\\", "/")
                text = open(local, "r", encoding="utf-8").read()
                patch_hashes[rel] = str(cyrb53(text))
        if patch_hashes:
            hashes[name] = patch_hashes
    return hashes


def iter_faust_files():
    if not os.path.isdir(FAUST_DIR):
        return
    for dirpath, _dirnames, filenames in os.walk(FAUST_DIR):
        rel_dir = os.path.relpath(dirpath, FAUST_DIR)
        for name in filenames:
            if name.startswith("worklet_") or name.endswith(".dsp"):
                continue
            if name == "catalog.js":
                continue
            local = os.path.join(dirpath, name)
            if rel_dir == ".":
                rel_path = name
            else:
                rel_path = rel_dir.replace("\\", "/") + "/" + name
            yield local, rel_path


def pack_static(work_dir, skip_faust=False):
    packed = os.path.join(work_dir, "app")
    os.makedirs(packed, exist_ok=True)
    for name in STATIC_FILES:
        gzip_file(os.path.join(APP_DIR, name), os.path.join(packed, name + ".gz"))
    if skip_faust:
        return packed
    catalog = os.path.join(FAUST_DIR, "catalog.js")
    if os.path.isfile(catalog):
        data = open(catalog, "r", encoding="utf-8").read()
        data += "\nwindow.FAUST_DSP_HASHES = %s;\n" % json.dumps(
            faust_dsp_hashes(), separators=(",", ":")
        )
        write_gzip(
            data.encode("utf-8"),
            os.path.join(packed, "faust", "catalog.js.gz"),
            "catalog.js",
        )
    for local, rel_path in iter_faust_files() or ():
        gzip_file(local, os.path.join(packed, "faust", rel_path + ".gz"))
    return packed


def block_bytes(size):
    return max(FLASH_BLOCK, ((size + FLASH_BLOCK - 1) // FLASH_BLOCK) * FLASH_BLOCK)


def flash_cost(path):
    cost = 0
    dirs = 0
    files = 0
    for dirpath, _dirnames, filenames in os.walk(path):
        dirs += 1
        for name in filenames:
            cost += block_bytes(os.path.getsize(os.path.join(dirpath, name)))
            files += 1
    cost += dirs * DIR_BLOCKS * FLASH_BLOCK
    return cost, files, dirs


def firmware_flash_cost():
    cost = 0
    for name in ("main.py", "config.py"):
        cost += block_bytes(os.path.getsize(os.path.join(FIRMWARE_DIR, name)))
    return cost


def fs_info(port):
    result = run_mpremote(port, ["exec", FS_INFO], check=False)
    text = (result.stdout or "") + (result.stderr or "")
    for line in text.splitlines():
        if line.startswith("FS "):
            parts = line.split()
            return int(parts[1]), int(parts[2])
    return None, None


def pull_settings(port):
    """Lit settings.json avant un formatage. b'' si absent, None si illisible."""
    result = run_mpremote(port, ["exec", PULL_SETTINGS], check=False)
    text = (result.stdout or "") + (result.stderr or "")
    for line in text.splitlines():
        if line.startswith("SETTINGS_B64 "):
            raw = line.split(" ", 1)[1].strip()
            if not raw:
                return b""
            try:
                return base64.b64decode(raw)
            except (ValueError, TypeError):
                return None
    return None


def push_settings(port, data):
    if not data:
        return
    fd, path = tempfile.mkstemp(prefix="pico-settings-", suffix=".json")
    os.close(fd)
    try:
        with open(path, "wb") as handle:
            handle.write(data)
        run_mpremote(port, ["cp", path, ":settings.json"])
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def format_fs(port):
    saved = pull_settings(port)
    if saved is None:
        print("settings.json illisible : le formatage continue sans le recopier.")
    print("LittleFS saturé : reformatage du Pico…")
    run_mpremote(port, ["exec", FORMAT_FS])
    if saved:
        push_settings(port, saved)
        print("Réglages conservés (%d octets)." % len(saved))


def too_small(total, needed):
    raise SystemExit(
        "Système de fichiers trop petit : %d Ko, il en faut environ %d Ko. "
        "Passez sur un Pico 2 W avec le MicroPython « RPI_PICO2_W »."
        % (total // 1024, (needed + FLASH_HEADROOM) // 1024)
    )


def prepare_fs(port, needed):
    total, free = fs_info(port)
    if total is None:
        # Pico injoignable (port occupé, mpremote en échec) : ne jamais
        # formater à l'aveugle, settings.json serait perdu.
        raise SystemExit(
            "Impossible de lire la flash du Pico. Fermez Thonny ou tout "
            "terminal série, rebranchez le Pico et relancez."
        )
    print("Flash Pico : %d Ko au total, %d Ko libres" % (total // 1024, free // 1024))
    if total < needed + FLASH_HEADROOM:
        too_small(total, needed)
    if free < needed + FLASH_HEADROOM:
        format_fs(port)
        total, free = fs_info(port)
        if total is not None:
            print("Après format : %d Ko libres" % (free // 1024))
            if free < needed + FLASH_HEADROOM:
                too_small(total, needed)


def ensure_dir(port, path):
    run_mpremote(port, ["mkdir", ":" + path], check=False)


def copy_tree(port, packed):
    created = set()

    def mkdir(path):
        if path in created:
            return
        ensure_dir(port, path)
        created.add(path)

    mkdir("app")
    for name in STATIC_FILES:
        local = os.path.join(packed, name + ".gz")
        run_mpremote(port, ["cp", local, ":app/" + name + ".gz"])
    faust_packed = os.path.join(packed, "faust")
    if not os.path.isdir(faust_packed):
        return
    for dirpath, _dirnames, filenames in os.walk(faust_packed):
        rel_dir = os.path.relpath(dirpath, faust_packed).replace("\\", "/")
        remote_dir = "app/faust" if rel_dir == "." else "app/faust/" + rel_dir
        mkdir(remote_dir)
        for name in filenames:
            local = os.path.join(dirpath, name)
            remote = remote_dir + "/" + name
            run_mpremote(port, ["cp", local, ":" + remote])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", help="Port série du Pico, ex. COM16")
    parser.add_argument("--no-reset", action="store_true")
    parser.add_argument(
        "--format",
        action="store_true",
        help="Reformater LittleFS avant la copie",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Ne recopier que le firmware et les fichiers principaux de app",
    )
    args = parser.parse_args()
    try:
        import mpremote  # noqa: F401
    except ImportError:
        raise SystemExit(
            "mpremote manque pour %s. Installez-le :\n    %s -m pip install mpremote"
            % (sys.executable, sys.executable)
        )
    port = args.port or find_pico_port()
    if port:
        print("Pico sur", port)
    else:
        print("Aucun Pico trouvé, mpremote choisira le premier port.")

    work_dir = tempfile.mkdtemp(prefix="pico-app-")
    packed = pack_static(work_dir, skip_faust=args.quick)
    cost, files, dirs = flash_cost(packed)
    cost += firmware_flash_cost()
    print(
        "Paquet : %d fichiers, %d dossiers, ~%d Ko flash (blocs 4 Ko)"
        % (files, dirs, cost // 1024)
    )
    try:
        if args.format:
            format_fs(port)
        elif not args.quick:
            prepare_fs(port, cost)
        run_mpremote(port, ["cp", os.path.join(FIRMWARE_DIR, "main.py"), ":main.py"])
        run_mpremote(port, ["cp", os.path.join(FIRMWARE_DIR, "config.py"), ":config.py"])
        copy_tree(port, packed)
        run_mpremote(
            port,
            ["exec", "compile(open('main.py').read(), 'main.py', 'exec'); print('firmware ok')"],
        )
        total, free = fs_info(port)
        if total is not None:
            print("Flash restante : %d Ko" % (free // 1024))
        if not args.no_reset:
            run_mpremote(port, ["reset"], check=False)
            print("Pico redémarré.")
        print("Connectez-vous au Wi-Fi « Plante-Musicale » (mot de passe biosonique)")
        print("puis ouvrez http://192.168.4.1")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
