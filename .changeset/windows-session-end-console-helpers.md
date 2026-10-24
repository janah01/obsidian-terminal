---
"obsidian-terminal": patch
---

On Windows, when a ConPTY terminal closes or Obsidian quits, console programs that the shell left running in a console of their own, hidden or visible, now end with the terminal instead of staying behind with their console hosts. Programs with a window started from the terminal, such as an editor or a browser, keep running, and so do the programs running under them and programs started without any console. A program still running in the terminal gets a moment to react to the close before it is ended. (by [@janah01](https://github.com/janah01))
