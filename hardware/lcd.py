"""Grove LCD (16x2 text) on any I2C port of the Grove hat. Black and white: no backlight colors.

    python3 lcd.py "Hello" "Buzzkill"     # test: shows 2 lines
"""
import sys
import time

from smbus2 import SMBus

TEXT = 0x3E          # the text chip

# Colors are kept as names so brick.py can say what it means; this screen ignores them.
HONEY = GREEN = RED = BLUE = WHITE = None


class LCD:
    def __init__(self, bus=1):
        self.bus = SMBus(bus)
        self.lines = [None, None]
        # Start-up order from Seeed's own driver: 2-line mode first (sent 3 times), then display on, clear, left-to-right
        time.sleep(0.05)
        for _ in range(3):
            self._cmd(0x28)
            time.sleep(0.005)
        self._cmd(0x0C)          # display on, no cursor, no blink
        self._cmd(0x01)          # clear
        time.sleep(0.005)
        self._cmd(0x06)          # text goes left to right

    def _cmd(self, c):
        self.bus.write_byte_data(TEXT, 0x80, c)

    def show(self, top="", bottom="", color=None):
        # Only rewrites what changed, so updating a few times a second doesn't flicker
        for row, text in enumerate((top, bottom)):
            text = text[:16].ljust(16)
            if text != self.lines[row]:
                self._cmd(0x80 | (0x40 * row))          # go to the start of the row
                for ch in text:
                    self.bus.write_byte_data(TEXT, 0x40, ord(ch) if 32 <= ord(ch) < 127 else ord("?"))
                self.lines[row] = text


if __name__ == "__main__":
    LCD().show(*(sys.argv[1:3] or ["Buzzkill", "LCD works!"]))
