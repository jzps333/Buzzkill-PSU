"""Text-to-speech for the Pi speaker.

Uses ElevenLabs when ELEVENLABS_API_KEY is set, otherwise falls back to
espeak (or `say` on a Mac). Lines are spoken one at a time, and every line
can be tagged with a player's name so a shake can cancel just their roast.
"""

import asyncio
import hashlib
import os
import shutil
from collections import deque
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).parent / "cache"
ELEVEN_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128"


def _mp3_player():
    if shutil.which("mpg123"):
        return ["mpg123", "-q"]
    if shutil.which("ffplay"):
        return ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if shutil.which("afplay"):  # macOS, handy for testing on a laptop
        return ["afplay"]
    return None


def _local_tts():
    for cmd in ("espeak-ng", "espeak"):
        if shutil.which(cmd):
            return [cmd, "-s", "165"]
    if shutil.which("say"):
        return ["say"]
    return None


class Speaker:
    def __init__(self):
        self.api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
        # "George" is one of ElevenLabs' default voices. Swap in any voice ID.
        self.voice = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb").strip()
        self.model = os.getenv("ELEVENLABS_MODEL", "eleven_flash_v2_5").strip()
        self.player = _mp3_player()
        self.local = _local_tts()
        self.pending = deque()
        self.wake = asyncio.Event()
        self.current_tag = None
        self.current_proc = None
        self.current_cancelled = False
        self.client = httpx.AsyncClient(timeout=15)
        CACHE_DIR.mkdir(exist_ok=True)

        if self.api_key and self.player:
            print(f"[speech] ElevenLabs voice {self.voice} ({self.model})")
        elif self.api_key:
            print("[speech] ElevenLabs key found but no mp3 player. Run: sudo apt install mpg123")
        else:
            print("[speech] No ELEVENLABS_API_KEY, using", self.local[0] if self.local else "print only")

    def say(self, text, tag=None):
        self.pending.append((tag, text))
        self.wake.set()

    def cancel(self, tag):
        """Drop queued lines for this tag and cut off the one playing, if it's theirs."""
        self.pending = deque(item for item in self.pending if item[0] != tag)
        if self.current_tag == tag:
            self.current_cancelled = True
            if self.current_proc and self.current_proc.returncode is None:
                self.current_proc.terminate()

    async def run(self):
        while True:
            if not self.pending:
                self.wake.clear()
                await self.wake.wait()
                continue
            tag, text = self.pending.popleft()
            self.current_tag, self.current_cancelled = tag, False
            print(f"[speak] {text}")
            try:
                await self._speak(text)
            except Exception as e:  # never let a bad line kill the speaker loop
                print(f"[speech] error: {e}")
            self.current_tag, self.current_proc = None, None

    async def _speak(self, text):
        mp3 = await self._elevenlabs(text) if self.api_key and self.player else None
        if self.current_cancelled:
            return
        if mp3:
            await self._run([*self.player, str(mp3)])
        elif self.local:
            await self._run([*self.local, text])

    async def _elevenlabs(self, text):
        key = hashlib.sha1(f"{self.voice}|{self.model}|{text}".encode()).hexdigest()
        path = CACHE_DIR / f"{key}.mp3"
        if path.exists():
            return path
        try:
            r = await self.client.post(
                ELEVEN_URL.format(voice=self.voice),
                headers={"xi-api-key": self.api_key, "accept": "audio/mpeg"},
                json={"text": text, "model_id": self.model},
            )
            r.raise_for_status()
        except httpx.HTTPError as e:
            detail = getattr(getattr(e, "response", None), "text", "")[:200]
            print(f"[speech] ElevenLabs failed, falling back to local voice: {e} {detail}")
            return None
        path.write_bytes(r.content)
        return path

    async def _run(self, cmd):
        self.current_proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
        )
        await self.current_proc.wait()
