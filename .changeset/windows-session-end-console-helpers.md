---
"obsidian-terminal": patch
---

On Windows, closing a ConPTY terminal or quitting Obsidian now also ends the console programs the shell left running in a console of their own, such as hidden helpers. A console window opened from the terminal, for example with `start cmd`, closes with it too. These keep running when a program started from them, such as an app opened from that `start cmd`, still shows a window. Programs with a window keep running, such as an editor, a browser or a Python app that shows one, and so do programs started without a console and whatever runs under them. A program still running in the terminal is closed by the console host, as before. (by [@janah01](https://github.com/janah01))
