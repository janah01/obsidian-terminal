---
"obsidian-terminal": patch
---

Keymappings have a new action, Send to Obsidian. While a terminal has the focus, a key with this action runs its Obsidian hotkey, and the shell does not get it. Two such keymappings come built in, and the update adds them once: `Ctrl`+`P` on Windows and `Command`+`P` on macOS, so the command palette opens from a focused terminal. Linux has none, because bash and zsh use `Ctrl`+`P`. On Windows, bash in WSL and Git Bash lose `Ctrl`+`P` as well; delete the keymapping under Settings → Keymappings to give the key back. (by [@janah01](https://github.com/janah01))
