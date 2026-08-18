"""Who Scrappy is talking to.

The setup panel writes SCRAPPY_USER_NAME. Electron passes it into this process.
Nothing here should assume a specific person.
"""

from __future__ import annotations

import os


def name() -> str:
    raw = (os.environ.get("SCRAPPY_USER_NAME") or "").strip()
    return raw or "the user"


def possessive() -> str:
    who = name()
    if who.lower() == "the user":
        return "the user's"
    if who.lower().endswith("s"):
        return f"{who}'"
    return f"{who}'s"
