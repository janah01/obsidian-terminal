#!/usr/bin/env python3
"""Deterministic stand-in for a Claude Code session inside the Terminal view.

Prints vault-relative paths the way an agent reports edited files, then keeps
an interactive prompt open. Its pid is written to $AGENT_PID_FILE so the
harness can prove whether the process survived a link click.
"""

import os
import sys
import uuid

session = uuid.uuid4().hex[:6]
pid_file = os.environ.get("AGENT_PID_FILE", "/home/claude/e2e/run/agent.pid")
with open(pid_file, "w") as f:
    f.write(str(os.getpid()))

lines = [
    f"\x1b[1;35m* agent session {session}\x1b[0m  pid {os.getpid()}  (stand-in for Claude Code)",
    "",
    "\x1b[32m⏺\x1b[0m Updated Notes/Target.md",
    "\x1b[32m⏺\x1b[0m Read (Projects/Folder With Spaces/Meeting notes 2026.md)",
    "\x1b[32m⏺\x1b[0m Read (Quotes/Don't panic.md)",
    '\x1b[32m⏺\x1b[0m Wrote "Quoted/wrapped-in-quotes.md"',
    "\x1b[32m⏺\x1b[0m Read (Unicode/日本語 ノート.md)",
    "\x1b[32m⏺\x1b[0m Read Unicode/Café-naïve.md",
    "\x1b[32m⏺\x1b[0m Read Nested/a/b/c/Deep.md",
    "",
    "Done. 7 files touched. Ask me anything.",
]
for line in lines:
    print(line)

while True:
    sys.stdout.write(f"\x1b[1;36magent[{session}]>\x1b[0m ")
    sys.stdout.flush()
    got = sys.stdin.readline()
    if not got:
        break
    print(f"agent[{session}] received: {got.strip()!r} (still running, pid {os.getpid()})")
