---
"obsidian-terminal": patch
---

The default hotkey `Ctrl`+`Shift`+`H` (`Command`+`Shift`+`H` on Apple devices) now runs "Open current directory in terminal: Integrated" instead of the root command. "Open current directory in terminal" now works when no file is active, for example in a focused terminal, on an empty tab or in the graph view. It opens a terminal in the folder of the file you looked at last, or in the vault root when no file is open or was opened recently. Before, it showed a notice and opened nothing. The command palette now lists these commands while a terminal is the active tab. (by [@janah01](https://github.com/janah01))
