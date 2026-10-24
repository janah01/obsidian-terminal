---
"obsidian-terminal": patch
---

Windows: the ConHost backend now starts programs such as cmd, PowerShell and Python with the same arguments as ConPTY. This also applies when a ConPTY profile falls back to ConHost. A cmd profile with `/d /k "prompt CMD$G$S"` now opens with its own prompt instead of an error. Arguments with `^`, a trailing backslash or letters such as `ü` now arrive unchanged. The exit code is no longer lost when the Windows user name has such letters. After you press Ctrl+C in a ConHost terminal, exiting the shell no longer stops at "Terminate batch job (Y/N)?". A command with a line break, or one longer than 8,191 characters, now shows an error instead of starting a different command. (by [@janah01](https://github.com/janah01))
