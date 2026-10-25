"""Touch the sensor and see it print. Ctrl+C to quit."""
from signal import pause

from gpiozero import Button

TOUCH_PIN = 5   # Grove port D5 = GPIO 5

# TTP223 sends 3.3V when touched, so no pull-up and "high = pressed"
touch = Button(TOUCH_PIN, pull_up=None, active_state=True)
touch.when_pressed = lambda: print("touched")
touch.when_released = lambda: print("released")
print("Touch the sensor (Ctrl+C to quit)")
pause()
