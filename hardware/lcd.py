"""Grove LCD RGB Backlight v4.0: 16x2 text + colored backlight, on any I2C port of the Grove hat.

    python3 lcd.py "Hello" "Buzzkill"     # test: shows 2 lines on a yellow background
"""
import sys
import time

from smbus2 import SMBus

TEXT = 0x3E          # the text chip
RGB = 0x62           # the backlight chip (v4.0)

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
        for reg, val in ((0x00, 0x00), (0x08, 0xFF), (0x01, 0x20)):   # backlight chip on (same as Seeed's own code)
            self.bus.write_byte_data(RGB, reg, val)

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
        if color and color != self.color:
            r, g, b = color
            self.bus.write_byte_data(RGB, 0x04, r)
            self.bus.write_byte_data(RGB, 0x03, g)
            self.bus.write_byte_data(RGB, 0x02, b)
            self.color = color


if __name__ == "__main__":
    LCD().show(*(sys.argv[1:3] or ["Buzzkill", "LCD works!"]), color=HONEY)
