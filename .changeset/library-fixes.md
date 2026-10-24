---
"obsidian-terminal": patch
---

Holding a hotkey in a focused terminal no longer sends the key to the shell once per key repeat. On Windows, holding `Ctrl`+`Shift`+`H` typed one `^H` per repeat in PowerShell and deleted one character per repeat in cmd. Updating the plugin no longer logs "Malformed data" and highlights Recover in the settings when the new version only adds settings. Import from clipboard now accepts settings and profiles exported by an older version. What they lack gets its default. Number fields in the settings keep what you type, so a font size of 14.5 or a notice timeout of 5.5 can be typed from left to right. (by [@janah01](https://github.com/janah01))
