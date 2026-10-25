"""Grove LCD RGB Backlight v4.0: 16x2 text + colored backlight, on any I2C port of the Grove hat.

    python3 lcd.py "Hello" "Buzzkill"     # test: shows 2 lines on a yellow background
"""
import sys
import time

from smbus2 import SMBus

TEXT = 0x3E          # the text chip
RGB_CHIPS = (0x62, 0x30)   # the backlight chip: 0x62 on v4.0, 0x30 on v5.0

HONEY = (255, 170, 0)
GREEN = (0, 200, 60)
RED = (255, 0, 0)
BLUE = (0, 90, 255)
WHITE = (255, 255, 255)


class LCD:
    def __init__(self, bus=1):
        self.bus = SMBus(bus)
        self.lines = [None, None]
        self.color = None
        time.sleep(0.05)
        self._cmd(0x01)          # clear
        time.sleep(0.05)
        self._cmd(0x0C)          # display on, no cursor
        self._cmd(0x28)          # 2 lines
        time.sleep(0.05)
        self.rgb = None          # no backlight chip found = text only, no colors
        for addr in RGB_CHIPS:
            try:
                if addr == 0x62:
                    for reg, val in ((0x00, 0x00), (0x08, 0xFF), (0x01, 0x20)):   # same as Seeed's own code
                        self.bus.write_byte_data(addr, reg, val)
                    self.regs = (0x04, 0x03, 0x02)
                else:
                    self.bus.write_byte_data(addr, 0x00, 0x07)
                    time.sleep(0.2)
                    self.bus.write_byte_data(addr, 0x04, 0x15)
                    self.regs = (0x06, 0x07, 0x08)
                self.rgb = addr
                break
            except OSError:
                pass
        if self.rgb is None:
            print("LCD backlight chip not found (0x62 / 0x30): text only, no colors")

    def _cmd(self, c):
        self.bus.write_byte_data(TEXT, 0x80, c)

    def show(self, top="", bottom="", color=None):
        # Only rewrites what changed, so updating twice a second doesn't flicker
        for row, text in enumerate((top, bottom)):
            text = text[:16].ljust(16)
            if text != self.lines[row]:
                self._cmd(0x80 | (0x40 * row))
                self.bus.write_i2c_block_data(TEXT, 0x40, [ord(c) if ord(c) < 128 else ord("?") for c in text])
                self.lines[row] = text
        if color and color != self.color and self.rgb:
            for reg, val in zip(self.regs, color):
                self.bus.write_byte_data(self.rgb, reg, val)
            self.color = color


if __name__ == "__main__":
    LCD().show(*(sys.argv[1:3] or ["Buzzkill", "LCD works!"]), color=HONEY)
