---
"obsidian-terminal": patch
---

Holding a hotkey in a focused terminal no longer sends the key to the shell once per key repeat. On Windows, holding `Ctrl`+`Shift`+`H` typed one `^H` per repeat in PowerShell and deleted one character per repeat in cmd. A hotkey that you gave to two commands keeps running the one it ran before the plugin loaded. Updating the plugin no longer logs "Malformed data" or highlights Recover in the settings when the new version only adds settings. Import from clipboard now accepts settings and profiles exported by an older version. What they lack gets its default. The data editor of the settings and of a profile now says why it refused data. The warning under the data field shows the reason, such as "Malformed data". It showed `{}` before. Number fields in the settings keep what you type, so a font size of 14.5 or a notice timeout of 5.5 can be typed from left to right. (by [@janah01](https://github.com/janah01))
