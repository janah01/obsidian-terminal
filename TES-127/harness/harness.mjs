// Drives a real Obsidian (under Xvfb) over CDP to reproduce / verify TES-127.
// Usage: node harness.mjs <label> <scenario> <pluginBuildDir>
//   scenario: tab-unpinned | tab-pinned | split | popout | ten-clicks | special
import { chromium } from "playwright-core";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [label, scenario, pluginDir] = process.argv.slice(2);
const E2E = "/home/claude/e2e";
const OBSIDIAN = "/home/claude/obsidian-bin/obsidian-1.14.4/obsidian";
const W = 1600,
  H = 1000,
  DISPLAY = ":99";
const runDir = path.join(E2E, "run");
const outDir = path.join(E2E, "evidence", label, scenario);
const pidFile = path.join(runDir, "agent.pid");
const TERMINAL_TYPE = "terminal:terminal";

const SCENARIOS = {
  "tab-unpinned": { behavior: "replaceTab", pinned: false },
  "tab-pinned": { behavior: "replaceTab", pinned: true },
  split: { behavior: "newVerticalSplit", pinned: false, openFirst: "Welcome.md" },
  popout: { behavior: "newWindow", pinned: false, openFirst: "Welcome.md" },
  "ten-clicks": { behavior: "replaceTab", pinned: false },
  // Last active note lives in a sidebar that was collapsed afterwards.
  "sidebar-note": { behavior: "replaceTab", pinned: false, sidebarNote: true },
  special: { behavior: "replaceTab", pinned: false },
};
const cfg = SCENARIOS[scenario];
if (!cfg) throw new Error(`unknown scenario ${scenario}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${label}/${scenario}]`, ...a);
const results = { label, scenario, config: cfg, steps: [], verdict: null };
let shot = 0;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const { home, vault } = JSON.parse(
  execFileSync("node", [
    path.join(E2E, "setup.mjs"),
    pluginDir,
    runDir,
    cfg.behavior,
    String(cfg.pinned),
  ]).toString(),
);

const procs = [];
function start(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  const logFile = fs.createWriteStream(path.join(outDir, `${path.basename(cmd)}.log`));
  p.stdout.pipe(logFile);
  p.stderr.pipe(logFile);
  procs.push(p);
  return p;
}

async function waitFor(fn, what, timeout = 30000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(every);
  }
}

// Alive = the process exists and is not a zombie; also report its pty so a
// detached/orphaned agent is visible in the evidence.
function agentAlive() {
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const tty = fs.readlinkSync(`/proc/${pid}/fd/0`);
    return { pid, alive: state !== "Z" && state !== "X", state, ppid: Number(fields[1]), tty };
  } catch (e) {
    return { pid, alive: false, error: String(e.code ?? e) };
  }
}
function processTree() {
  try {
    return execFileSync("ps", ["-eo", "pid,ppid,stat,tty,args", "--forest"]).toString()
      .split("\n")
      .filter((l) => /^\s*PID|\/bin\/zsh --login|fake-agent\.py$|Unix PTY proxy/.test(l) && !/harness|eval /.test(l))
      .map((l) => l.replace(/python3 -c """Unix PTY proxy.*/, "python3 -c <unix_pseudoterminal.py host>"))
      .join("\n");
  } catch {
    return "";
  }
}

// ---- in-page helpers (run in Obsidian's main renderer) ----
const PAGE_HELPERS = `
window.__e2e ??= {};
__e2e.leaves = () => { const out = []; app.workspace.iterateAllLeaves((l) => { out.push(l); }); return out; };
__e2e.describe = (l) => ({
  type: l.view.getViewType(),
  file: l.view.file ? l.view.file.path : null,
  pinned: !!l.getViewState().pinned,
  window: l.view.containerEl.win === window ? "main" : "popout",
  isTerminalLeaf: l === __e2e.termLeaf,
});
__e2e.bufferText = () => {
  const t = __e2e.termView?.emulator?.terminal; if (!t) return null;
  const b = t.buffer.active, rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? "");
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.join("\\n");
};
__e2e.state = () => {
  const leaves = __e2e.leaves();
  const tl = __e2e.termLeaf;
  const attached = leaves.includes(tl);
  const active = app.workspace.activeLeaf;
  const doc = active?.view.containerEl.doc ?? document;
  const focusEl = doc.activeElement;
  return {
    leaves: leaves.filter((l) => l.getRoot() !== app.workspace.leftSplit && l.getRoot() !== app.workspace.rightSplit).map(__e2e.describe),
    terminalLeafAttached: attached,
    terminalLeafStillHasTerminalView: attached && tl.view === __e2e.termView,
    terminalLeafNowShows: attached ? __e2e.describe(tl) : null,
    terminalViewMounted: !!__e2e.termView?.containerEl?.isConnected,
    activeLeaf: active ? __e2e.describe(active) : null,
    activeFile: app.workspace.getActiveFile()?.path ?? null,
    focusInActiveLeaf: !!(focusEl && active && active.view.containerEl.contains(focusEl)),
    focusIsEditor: !!focusEl?.closest?.(".cm-editor"),
    focusElement: focusEl ? [focusEl.tagName.toLowerCase(), ...focusEl.classList].join(".") : null,
    activeMode: active?.view.getMode?.() ?? null,
    activeLeafVisible: !!active && active.view.containerEl.getBoundingClientRect().width > 0 &&
      !(active.getRoot() === app.workspace.rightSplit && app.workspace.rightSplit.collapsed) &&
      !(active.getRoot() === app.workspace.leftSplit && app.workspace.leftSplit.collapsed),
    activeLeafRoot: !active ? null : active.getRoot() === app.workspace.rightSplit ? "right sidebar" : active.getRoot() === app.workspace.leftSplit ? "left sidebar" : "main/popout",
  };
};
// Locate text in the visible viewport using the buffer's own cell layout.
__e2e.locate = (needle) => {
  const t = __e2e.termView.emulator.terminal, b = t.buffer.active;
  for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
    const line = b.getLine(y); if (!line) continue;
    let s = "", cols = [];
    for (let x = 0; x < t.cols; x++) {
      const c = line.getCell(x); if (!c || c.getWidth() === 0) continue;
      const ch = c.getChars() || " ";
      for (const _ of ch) cols.push(x);
      s += ch;
    }
    const i = s.indexOf(needle); if (i < 0) continue;
    const screen = __e2e.termView.containerEl.querySelector(".xterm-screen").getBoundingClientRect();
    const cw = screen.width / t.cols, chh = screen.height / t.rows;
    const col = cols[Math.min(i + 2, cols.length - 1)];
    return { x: screen.left + (col + 0.5) * cw, y: screen.top + (y - b.viewportY + 0.5) * chh, row: y, col };
  }
  return null;
};
true;
`;

async function main() {
  start("Xvfb", [DISPLAY, "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"]);
  await sleep(800);
  const ffmpeg = start("ffmpeg", [
    "-y", "-f", "x11grab", "-video_size", `${W}x${H}`, "-framerate", "12",
    "-i", DISPLAY, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    path.join(outDir, "recording.mp4"),
  ]);
  const env = { ...process.env, HOME: home, DISPLAY, AGENT_PID_FILE: pidFile, SHELL: "/bin/zsh" };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  start(OBSIDIAN, ["--no-sandbox", "--remote-debugging-port=9222", "--disable-gpu"], { env });

  await waitFor(async () => (await fetch("http://127.0.0.1:9222/json/version")).ok, "CDP");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const main = await waitFor(
    () => ctx.pages().find((p) => p.url().startsWith("app://") && !p.url().includes("starter")),
    "main window",
  );
  await main.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60000 });
  // Fill the virtual screen with the main window (there is no window manager).
  await main.evaluate(([w, h]) => {
    const win = require("electron").remote?.getCurrentWindow?.() ?? require("@electron/remote").getCurrentWindow();
    win.setBounds({ x: 0, y: 0, width: w, height: h });
  }, [W, H]).catch((e) => log("resize failed", e.message));
  await main.evaluate(PAGE_HELPERS);

  // First-open trust prompt: answer it the way the user would.
  const trust = main.getByRole("button", { name: "Trust author and enable plugins" });
  await trust.click({ timeout: 15000 }).catch(() => log("no trust prompt"));
  await sleep(1500);
  // Trusting opens the community-plugins settings; close it like the user would.
  await main.evaluate(() => app.setting?.close?.());
  await sleep(300);
  await main.evaluate(async () => {
    await app.plugins.setEnable(true);
    await app.plugins.enablePluginAndSave("terminal");
  });
  await main.waitForFunction(() => !!app.plugins.plugins.terminal, null, { timeout: 30000 });
  await main.evaluate(() => {
    app.workspace.rightSplit.collapse();
    // Start from one clean root tab.
    const roots = [];
    app.workspace.iterateRootLeaves((l) => { roots.push(l); });
    roots.slice(1).forEach((l) => l.detach());
  });
  if (cfg.openFirst) {
    await main.evaluate(async (f) => {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath(f), { active: true });
    }, cfg.openFirst);
  } else {
    await main.evaluate(() => app.workspace.setActiveLeaf(app.workspace.getLeaf(false), { focus: true }));
  }
  await sleep(500);

  // Open the terminal through the plugin's own command.
  const before = await main.evaluate(() => __e2e.leaves().length);
  await main.evaluate(() => app.commands.executeCommandById("terminal:open-terminal.integrated.root"));
  await main.waitForFunction(
    (t) => __e2e.leaves().some((l) => l.view.getViewType() === t && l.view.emulator?.terminal),
    TERMINAL_TYPE,
    { timeout: 30000 },
  );
  await main.evaluate((t) => {
    __e2e.termLeaf = __e2e.leaves().find((l) => l.view.getViewType() === t);
    __e2e.termView = __e2e.termLeaf.view;
  }, TERMINAL_TYPE);
  const termWin = await main.evaluate(() => __e2e.describe(__e2e.termLeaf).window);
  let termPage = main;
  if (termWin === "popout") {
    termPage = await waitFor(async () => {
      for (const p of ctx.pages()) {
        if (p !== main && (await p.evaluate(() => document.body.classList.contains("is-popout-window")).catch(() => false))) return p;
      }
      return null;
    }, "popout page");
    await main.evaluate(([w, h]) => {
      const win = __e2e.termView.containerEl.win;
      win.resizeTo(w * 0.55, h * 0.75);
      win.moveTo(w * 0.42, h * 0.2);
    }, [W, H]).catch(() => {});
  }
  log("terminal opened in", termWin, "leaves", before, "->", await main.evaluate(() => __e2e.leaves().length));

  // Wait for the zsh prompt, then launch the stand-in agent by typing like a user.
  await waitFor(() => main.evaluate(() => /zsh/.test(__e2e.bufferText() ?? "")), "zsh prompt", 30000);
  await main.evaluate(() => __e2e.termView.emulator.terminal.focus());
  await termPage.keyboard.type(`python3 ${E2E}/fake-agent.py`, { delay: 15 });
  await termPage.keyboard.press("Enter");
  await waitFor(() => main.evaluate(() => /agent\[[0-9a-f]{6}\]>/.test(__e2e.bufferText() ?? "")), "agent prompt");
  await sleep(600);

  results.modalsOpenBeforeClicks = await main.evaluate(() => document.querySelectorAll(".modal-container").length);
  if (results.modalsOpenBeforeClicks) throw new Error("a modal is covering the workspace");
  const baseline = await main.evaluate(() => __e2e.bufferText());
  const baseHash = crypto.createHash("sha256").update(baseline).digest("hex").slice(0, 12);
  fs.writeFileSync(path.join(outDir, "scrollback-baseline.txt"), baseline);
  results.baseline = { scrollbackSha: baseHash, agent: agentAlive(), processTree: processTree(), state: await main.evaluate(() => __e2e.state()) };
  await screenshot(main, termPage, "terminal-with-agent");

  if (cfg.sidebarNote) {
    await main.evaluate(async () => {
      const leaf = app.workspace.getRightLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Welcome.md"), { active: true });
      app.workspace.rightSplit.collapse();
    });
    await sleep(500);
    const hdr = await main.evaluate(() => {
      const r = __e2e.termLeaf.tabHeaderEl.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await termPage.mouse.click(hdr.x, hdr.y);
    await sleep(500);
  }

  const plan = {
    "tab-unpinned": ["Notes/Target.md"],
    "tab-pinned": ["Notes/Target.md"],
    split: ["Notes/Target.md"],
    popout: ["Notes/Target.md"],
    "sidebar-note": ["Notes/Target.md"],
    "ten-clicks": Array.from({ length: 10 }, (_, i) =>
      ["Notes/Target.md", "Nested/a/b/c/Deep.md", "Unicode/Café-naïve.md"][i % 3]),
    special: [
      "Projects/Folder With Spaces/Meeting notes 2026.md",
      "Quotes/Don't panic.md",
      "Quoted/wrapped-in-quotes.md",
      "Unicode/日本語 ノート.md",
      "Unicode/Café-naïve.md",
      "Nested/a/b/c/Deep.md",
    ],
  }[scenario];

  for (const [i, target] of plan.entries()) {
    const n = i + 1;
    if (i > 0) {
      // Return to the terminal the way a user does: click its tab header.
      const ok = await main.evaluate(() => __e2e.leaves().includes(__e2e.termLeaf) && __e2e.termLeaf.view === __e2e.termView);
      if (!ok) { log("terminal gone, stopping"); break; }
      const hdr = await main.evaluate(() => {
        const r = __e2e.termLeaf.tabHeaderEl.getBoundingClientRect();
        return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      if (hdr) await termPage.mouse.click(hdr.x, hdr.y);
      else await main.evaluate(() => app.workspace.setActiveLeaf(__e2e.termLeaf, { focus: true }));
      await sleep(500);
    }
    const pos = await main.evaluate((t) => __e2e.locate(t), target);
    if (!pos) throw new Error(`could not find ${target} on screen`);
    await termPage.mouse.move(pos.x, pos.y);
    await sleep(400); // let xterm's link provider underline it
    const hovered = await main.evaluate(() => !!__e2e.termView.containerEl.querySelector(".xterm-screen .xterm-cursor-pointer, .xterm-cursor-pointer"));
    if (n === 1) await screenshot(main, termPage, "hover-link");
    if (n === 1) {
      // What the ticket's suggested getMostRecentLeaf() would return at click time.
      results.mostRecentLeafAtClick = await main.evaluate(() => {
        const l = app.workspace.getMostRecentLeaf();
        return l ? { isTerminalLeaf: l === __e2e.termLeaf, type: l.view.getViewType() } : null;
      });
    }
    await termPage.mouse.click(pos.x, pos.y);
    await sleep(1200);
    const state = await main.evaluate(() => __e2e.state());
    const scroll = state.terminalViewMounted ? await main.evaluate(() => __e2e.bufferText()) : null;
    const agent = agentAlive();
    const step = {
      click: n,
      target,
      hovered,
      openedCorrectFile: state.activeFile === target,
      terminalKeptItsView: state.terminalLeafStillHasTerminalView,
      agent,
      processTree: processTree(),
      scrollbackUnchanged: scroll !== null && scroll === baseline,
      focusInOpenedNote: state.focusInActiveLeaf && state.activeLeaf?.file === target,
      openedNoteVisible: state.activeLeafVisible,
      state,
    };
    results.steps.push(step);
    log(`click ${n} ${target}: file=${state.activeFile} termView=${step.terminalKeptItsView} agent=${agent.alive} scroll=${step.scrollbackUnchanged} focus=${step.focusInOpenedNote} visible=${step.openedNoteVisible} (${state.activeLeafRoot})`);
    if (n === 1 || n === plan.length || !step.terminalKeptItsView) await screenshot(main, termPage, `after-click-${n}`);
  }

  await sleep(3000);
  results.agentAfterSettle = agentAlive();
  results.processTreeAfterSettle = processTree();
  // Return to the terminal and prove the prompt still answers.
  const alive = await main.evaluate(() => __e2e.leaves().includes(__e2e.termLeaf) && __e2e.termLeaf.view === __e2e.termView);
  if (alive) {
    const hdr = await main.evaluate(() => {
      const r = __e2e.termLeaf.tabHeaderEl.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (hdr) await termPage.mouse.click(hdr.x, hdr.y);
    await sleep(400);
    const xs = await main.evaluate(() => {
      const r = __e2e.termView.containerEl.querySelector(".xterm-screen").getBoundingClientRect();
      return { x: r.right - 20, y: r.bottom - 10 };
    });
    await termPage.mouse.click(xs.x, xs.y); // focus the terminal body
    await termPage.keyboard.type("still there?", { delay: 20 });
    await termPage.keyboard.press("Enter");
    await sleep(800);
    const text = await main.evaluate(() => __e2e.bufferText());
    results.promptRestored = /received: 'still there\?'/.test(text);
    results.finalAgent = agentAlive();
    await screenshot(main, termPage, "back-in-terminal");
  } else {
    results.promptRestored = false;
    results.finalAgent = agentAlive();
  }

  const s = results.steps;
  results.verdict = {
    clicks: s.length,
    plannedClicks: plan.length,
    allOpenedCorrectFile: s.length === plan.length && s.every((x) => x.openedCorrectFile),
    terminalNeverReplaced: s.length === plan.length && s.every((x) => x.terminalKeptItsView),
    agentAliveAfterEveryClick: s.length === plan.length && s.every((x) => x.agent.alive) && results.agentAfterSettle.alive,
    scrollbackUnchangedAfterEveryClick: s.length === plan.length && s.every((x) => x.scrollbackUnchanged),
    focusInOpenedNoteEveryClick: s.length === plan.length && s.every((x) => x.focusInOpenedNote),
    openedNoteVisibleEveryClick: s.length === plan.length && s.every((x) => x.openedNoteVisible),
    promptRestored: results.promptRestored,
  };
  results.verdict.pass = Object.entries(results.verdict)
    .filter(([k]) => !["clicks", "plannedClicks"].includes(k))
    .every(([, v]) => v === true);
  log("verdict", JSON.stringify(results.verdict));
  await sleep(800);
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  ffmpeg.kill("SIGINT");
  await sleep(1500);
  await browser.close().catch(() => {});
}

async function screenshot(main, termPage, name) {
  const file = path.join(outDir, `${String(++shot).padStart(2, "0")}-${name}.png`);
  // Whole virtual screen, so pop-out windows are captured too.
  execFileSync("import", ["-display", DISPLAY, "-window", "root", file]);
}

try {
  await main();
} catch (e) {
  results.error = String(e.stack ?? e);
  log("ERROR", e.message);
  try { await screenshot(null, null, "error"); } catch {}
  try {
    const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
    results.debugPages = b.contexts().flatMap((c) => c.pages().map((p) => p.url()));
    const m = b.contexts()[0].pages().find((p) => p.url().startsWith("app://"));
    results.debugLeaves = await m.evaluate(() => __e2e.leaves().map((l) => ({ type: l.view.getViewType(), em: !!l.view.emulator, win: l.view.containerEl.win === window })));
  } catch (err) { results.debugErr = String(err); }
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  for (const p of procs.reverse()) {
    try { p.kill("SIGINT"); } catch {}
  }
  await sleep(1500);
  for (const p of procs) {
    try { p.kill("SIGKILL"); } catch {}
  }
  try { execFileSync("pkill", ["-f", "fake-agent.py"]); } catch {}
  try { execFileSync("pkill", ["-f", "obsidian-1.14.4"]); } catch {}
}
