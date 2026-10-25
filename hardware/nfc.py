"""Write a website link to the ST25DV64K NFC tag over I2C.

A phone that taps the tag opens the link. No app needed.

    python3 nfc.py                                  # writes https://buzzkill-psu.vercel.app/
    python3 nfc.py https://www.buzzkill.study/join?room=4F2A9C
    python3 nfc.py --read                           # shows what's on the tag now
"""
import sys
import time

from smbus2 import SMBus, i2c_msg

BUS = 1              # Pi pins 3 (SDA) and 5 (SCL)
ADDR = 0x53          # ST25DV user memory
DEFAULT_URL = "https://buzzkill-psu.vercel.app/"

# Capability Container for a 64 Kbit (8 KB) tag: tells phones "there's NDEF data here"
CC = bytes([0xE2, 0x40, 0x00, 0x01, 0x00, 0x00, 0x04, 0x00])

# NFC shorthand for common link starts (saves bytes)
PREFIXES = [(0x04, "https://"), (0x03, "http://"), (0x02, "https://www."), (0x01, "http://www.")]


def ndef_url(url):
    code, rest = 0x00, url
    for c, p in sorted(PREFIXES, key=lambda x: -len(x[1])):
        if url.startswith(p):
            code, rest = c, url[len(p):]
            break
    payload = bytes([code]) + rest.encode()
    if len(payload) > 255:
        raise ValueError("URL too long")
    record = bytes([0xD1, 0x01, len(payload), 0x55]) + payload   # one short "U" (URI) record
    if len(record) < 0xFF:
        tlv = bytes([0x03, len(record)])
    else:
        tlv = bytes([0x03, 0xFF, len(record) >> 8, len(record) & 0xFF])
    return tlv + record + bytes([0xFE])                           # 0xFE = end


def write(bus, mem, data):
    # The chip saves 4 bytes at a time, so write in 4-byte pieces and wait for each to finish
    for i in range(0, len(data), 4):
        a = mem + i
        bus.i2c_rdwr(i2c_msg.write(ADDR, [a >> 8, a & 0xFF, *data[i:i + 4]]))
        for _ in range(50):          # chip ignores I2C while saving (~5 ms)
            try:
                bus.i2c_rdwr(i2c_msg.write(ADDR, [a >> 8, a & 0xFF]))
                break
            except OSError:
                time.sleep(0.002)


def read(bus, mem, n):
    w = i2c_msg.write(ADDR, [mem >> 8, mem & 0xFF])
    r = i2c_msg.read(ADDR, n)
    bus.i2c_rdwr(w, r)
    return bytes(r)


def write_url(url=DEFAULT_URL):
    data = CC + ndef_url(url)
    with SMBus(BUS) as bus:
        write(bus, 0x0000, data)
        if read(bus, 0x0000, len(data)) != data:
            raise RuntimeError("NFC tag write didn't stick (check wiring)")


def read_url():
    with SMBus(BUS) as bus:
        raw = read(bus, 0x0000, 8 + 4 + 300)
    body = raw[8:]
    if body[0] != 0x03:
        return None
    rec = body[2:2 + body[1]]
    n, code = rec[2], rec[4]
    prefix = dict(PREFIXES).get(code, "")
    return prefix + rec[5:4 + n].decode(errors="replace")


if __name__ == "__main__":
    if "--read" in sys.argv:
        print(read_url())
    else:
        url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
        write_url(url)
        print("Tag now opens:", read_url())
