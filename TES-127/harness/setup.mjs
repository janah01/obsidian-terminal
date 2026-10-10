// Creates a fresh, isolated Obsidian home + vault with the Terminal plugin build installed.
// Usage: node setup.mjs <pluginBuildDir> <runDir> <newInstanceBehavior> <pinNewInstance:true|false>
import fs from "node:fs";
import path from "node:path";

const [pluginDir, runDir, behavior, pinned] = process.argv.slice(2);
const home = path.join(runDir, "home");
const vault = path.join(runDir, "vault");
fs.rmSync(runDir, { recursive: true, force: true });

const notes = {
  "Welcome.md": "# Welcome\n\nThis is the note that was open before the terminal.\n",
  "Notes/Target.md": "# Target note\n\nOpened from a terminal link.\n",
  "Projects/Folder With Spaces/Meeting notes 2026.md":
    "# Meeting notes 2026\n\nPath with spaces.\n",
  "Quotes/Don't panic.md": "# Don't panic\n\nPath with an apostrophe.\n",
  "Quoted/wrapped-in-quotes.md":
    '# Wrapped in quotes\n\nPrinted as "Quoted/wrapped-in-quotes.md".\n',
  "Unicode/日本語 ノート.md": "# 日本語 ノート\n\nCJK path with a space.\n",
  "Unicode/Café-naïve.md": "# Café naïve\n\nLatin accents.\n",
  "Nested/a/b/c/Deep.md": "# Deep\n\nFour folders down.\n",
};
for (const [rel, body] of Object.entries(notes)) {
  const file = path.join(vault, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const obsidianDir = path.join(vault, ".obsidian");
const pluginOut = path.join(obsidianDir, "plugins", "terminal");
fs.mkdirSync(pluginOut, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(path.join(pluginDir, f), path.join(pluginOut, f));
}
fs.writeFileSync(
  path.join(obsidianDir, "community-plugins.json"),
  JSON.stringify(["terminal"]),
);
fs.writeFileSync(
  path.join(obsidianDir, "app.json"),
  JSON.stringify({ promptDelete: false }),
);
fs.writeFileSync(
  path.join(pluginOut, "data.json"),
  JSON.stringify({
    openChangelogOnUpdate: false,
    newInstanceBehavior: behavior,
    pinNewInstance: pinned === "true",
    preferredRenderer: "dom",
    defaultProfile: "zsh",
    profiles: {
      zsh: {
        args: ["--login"],
        environment: [],
        executable: "/bin/zsh",
        followTheme: true,
        name: "zsh",
        platforms: { darwin: true, linux: true },
        pythonExecutable: "python3",
        restoreHistory: false,
        rightClickAction: "copyPaste",
        successExitCodes: ["0", "SIGINT", "SIGTERM"],
        type: "integrated",
        win32Backend: "conpty",
      },
    },
  }),
);

const cfg = path.join(home, ".config", "obsidian");
fs.mkdirSync(cfg, { recursive: true });
fs.writeFileSync(
  path.join(cfg, "obsidian.json"),
  JSON.stringify({
    vaults: { e2e0000000000001: { path: vault, ts: Date.now(), open: true } },
    updateDisabled: true,
  }),
);
// Quiet zsh's first-run wizard and give it a recognisable prompt.
fs.writeFileSync(path.join(home, ".zshrc"), "PROMPT='%F{green}zsh%f %~ %# '\n");
console.log(JSON.stringify({ home, vault }));
