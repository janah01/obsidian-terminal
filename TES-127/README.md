# TES-127 evidence: clicking a vault path no longer replaces the terminal

Evidence for the fix on branch `ysrjanah/tes-127-clicking-a-file-path-in-terminal-output-replaces-the`
(commit `4ac00f9`, base `8cbff89` = 3.28.0).

Every run drives a **real Obsidian 1.14.4** (Linux build, under Xvfb) over the Chrome DevTools
Protocol. The harness types into a real **zsh login shell** in the Terminal view, starts an agent
process, moves the real mouse pointer onto a printed path (xterm's link underline appears), and
clicks. Nothing calls the link handler directly.

- `before` = plugin built from the base commit.
- `after` = plugin built from the fix commit.
- Same harness, same vault, same steps for both.

## Results

| Scenario | Before | After |
| --- | --- | --- |
| Terminal is the only tab, unpinned (the ticket's setup) | FAIL: terminal replaced, agent killed | PASS |
| Terminal is the only tab, **pinned** (plugin default) | PASS (bug masked) | PASS |
| Terminal in a split, note in the other pane | FAIL | PASS (note pane reused) |
| Terminal in a pop-out window | FAIL | PASS (opens in main-window note) |
| Paths with spaces, apostrophe, quoted path, CJK, accents, 4-deep nesting (6 clicks) | FAIL on click 1 | PASS 6/6 |
| 10 consecutive clicks, returning to the terminal tab between clicks | FAIL on click 1 | PASS 10/10 |
| Last active note sits in a collapsed sidebar | FAIL | PASS (sidebar revealed, note focused) |

Each run checks, after every click:

- The terminal leaf still hosts the same terminal view.
- The agent process is alive (read from `/proc`, and again 3 s later).
- The scrollback is byte-identical to the baseline.
- The opened file is the clicked path.
- Focus is in the opened note, and that note is visible.

After the last click, the harness clicks the terminal tab, types `still there?`, and checks
that the agent answers. Per-run data is in `runs/<before|after>/<scenario>/results.json`.

### Process tree, terminal as the only tab

Before the fix, 3 s after the click:

```text
  PID  PPID STAT TT       COMMAND
(python host, zsh and agent are gone; agent pid 8499 -> ENOENT)
```

After the fix, 3 s after the click:

```text
 7651  7627 S<   ?   \_ python3 -c <unix_pseudoterminal.py host>
 7652  7651 S<s  pts/0   \_ /bin/zsh --login
 7653  7652 S<+  pts/0       \_ python3 fake-agent.py     (alive, state S)
```

## Findings beyond the ticket text

1. **The bug needs an unpinned terminal.** With the plugin default "Pin new instance" on,
   `getLeaf(false)` skips the pinned terminal and the bug does not reproduce
   (`runs/before/tab-pinned`). It hits anyone who turned that setting off or unpinned the tab.
2. **`workspace.getMostRecentLeaf()` cannot be used as the ticket suggested.** At click time it
   returns the terminal itself in the tab, split and pop-out layouts
   (`runs/probe/getMostRecentLeaf.jsonl`). The fix uses the plugin's existing
   `TerminalView.lastActiveOtherLeaf` tracking, restricted to attached, unpinned `markdown` leaves.
3. **Collapsed sidebar.** If the last active note is in a sidebar that was later collapsed,
   opening there leaves it invisible and unfocused. The fix reveals the leaf before opening it
   (`runs/*/sidebar-note`).

## Reproduce by hand with Claude Code

Preconditions:

- The Terminal tab is **unpinned**: turn off Settings → Terminal → "Pin new instance", or
  right-click the tab → Unpin.
- The vault has `Notes/Target.md`.
- The terminal was opened at the vault root.

Run `claude` in the terminal and send this prompt:

```text
Print exactly this line and nothing else, then wait for my next message:
Notes/Target.md
```

Click the printed path. Before the fix, the Claude Code tab turns into the note and the session
ends. After the fix, the note opens beside it and the session keeps running.

The automated runs use `harness/fake-agent.py`, a deterministic stand-in that prints lines in
Claude Code's format (`⏺ Updated Notes/Target.md`). Real Claude Code needs its own login, which
the test machine does not have.

## Re-running

`harness/setup.mjs` builds an isolated home and vault. `harness/harness.mjs <before|after>
<scenario> <plugin build dir>` runs one scenario and writes screenshots, an MP4 and
`results.json`. It needs Xvfb, ffmpeg, ImageMagick, zsh, Node with `playwright-core`, and the
Obsidian Linux tarball. The paths at the top of `harness.mjs` are for the test machine.
