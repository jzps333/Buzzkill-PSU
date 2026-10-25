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

SYS = 0x57          # ST25DV settings
# Capability Container for a 64 Kbit (8 KB) tag: tells phones "there's NDEF data here".
# Last 2 bytes = NDEF area size / 8 = (8192 - 8) / 8 = 0x03FF, same as ST's own apps write.
CC = bytes([0xE2, 0x40, 0x00, 0x01, 0x00, 0x00, 0x03, 0xFF])

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


def write(bus, mem, data, addr=ADDR):
    # The chip saves 4 bytes at a time, so write in 4-byte pieces and wait for each to finish
    for i in range(0, len(data), 4):
        a = mem + i
        bus.i2c_rdwr(i2c_msg.write(addr, [a >> 8, a & 0xFF, *data[i:i + 4]]))
        for _ in range(50):          # chip ignores I2C while saving (~5 ms)
            try:
                bus.i2c_rdwr(i2c_msg.write(addr, [a >> 8, a & 0xFF]))
                break
            except OSError:
                time.sleep(0.002)


def read(bus, mem, n, addr=ADDR):
    w = i2c_msg.write(addr, [mem >> 8, mem & 0xFF])
    r = i2c_msg.read(addr, n)
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


def check():
    """Print the settings that decide whether phones can read the tag at all."""
    with SMBus(BUS) as bus:
        cc = read(bus, 0x0000, 8)
        rf = read(bus, 0x0003, 1, SYS)[0]        # bit 0 = radio off, bit 1 = radio asleep
        rf_now = read(bus, 0x2003, 1)[0]
        area1 = read(bus, 0x0004, 1, SYS)[0]     # bits 2-3 = phone read protection
    print("CC:", cc.hex(" "), "(good)" if cc == CC else "(old, run: python3 nfc.py)")
    print("Radio setting:", "ON" if rf & 3 == 0 else f"OFF ({rf:#04x}), run: python3 nfc.py --fix-rf")
    print("Radio right now:", "ON" if rf_now & 3 == 0 else f"OFF ({rf_now:#04x}), run: python3 nfc.py --fix-rf")
    print("Phone read lock:", "none" if area1 & 0x0C == 0 else f"LOCKED ({area1:#04x})")


def fix_rf():
    with SMBus(BUS) as bus:
        write(bus, 0x2003, [0x00])                                  # radio on now
        pw = [0] * 8                                                 # factory password is all zeros
        bus.i2c_rdwr(i2c_msg.write(SYS, [0x09, 0x00, *pw, 0x09, *pw]))   # unlock settings
        time.sleep(0.01)
        write(bus, 0x0003, [0x00], SYS)                             # radio on after power-up too
    check()


if __name__ == "__main__":
    if "--read" in sys.argv:
        print(read_url())
    elif "--check" in sys.argv:
        check()
    elif "--fix-rf" in sys.argv:
        fix_rf()
    else:
        url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
        write_url(url)
        print("Tag now opens:", read_url())
