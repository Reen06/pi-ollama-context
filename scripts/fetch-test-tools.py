#!/usr/bin/env python3
"""Fetch exact, checksum-verified integration fixtures. No npm install/hooks.

Usage: python3 scripts/fetch-test-tools.py DIRECTORY
Only Linux x86-64 Pi is supplied. Not run by the extension or package installation.
"""
import base64
import hashlib
import pathlib
import sys
import tarfile
import urllib.request

out = pathlib.Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
fixtures = [
    ("pi", "https://github.com/earendil-works/pi/releases/download/v1.3.0/pi-linux-x64.tar.gz",
     "sha256", "24f5be328b66d4da36876296989501974f43ab8434fbb57c35c523a3ea505ded"),
    ("discovery", "https://registry.npmjs.org/@jamesjfoong/pi-ollama/-/pi-ollama-1.0.3.tgz",
     "sha512", base64.b64decode("dmN9EQ9ZFGKY9gtTvZNHvu6TDJwn/cnnbadPCNILD7nVo6S4gFz/jr/sAYKlt0MA/i3gBkZT8e1zL0256qtWtg==").hex()),
]
for name, url, algorithm, expected in fixtures:
    archive = out / (name + ".tgz")
    with urllib.request.urlopen(url, timeout=90) as response, archive.open("wb") as target:
        while chunk := response.read(1024 * 1024):
            target.write(chunk)
    actual = hashlib.file_digest(archive.open("rb"), algorithm).hexdigest()
    if actual != expected:
        raise SystemExit(f"Integrity mismatch: {name}; refusing to execute")
    destination = out / name
    destination.mkdir(exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(destination, filter="data")
    print(f"Verified {name}: {actual}")
print(f"PI_BINARY={out}/pi/pi/pi")
print(f"PI_OLLAMA_EXTENSION={out}/discovery/package/extensions/index.ts")
