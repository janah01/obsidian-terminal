// TES-104 sweep: types into every text field in the Terminal plugin's settings
// tab, profile editor and their sub-editors at a mid-value caret, and records
// value, caret, focus and scroll after each step.
// Usage: node sweep.mjs <label> <outdir>
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect, trustAndTheme, openTerminalSettings, caret, sleep } from "./lib.mjs";

const [label, outDir] = process.argv.slice(2);
const KEY_DELAY = 260; // ms between keystrokes so refreshes settle and video reads
const c = await connect();
const m = c.main;
await trustAndTheme(m);
const win = await openTerminalSettings(c);
const results = [];

const hud = async (text, tone = "info") => {
  for (const p of [win]) {
    await p.evaluate(
      ([text, tone, label]) => {
        let el = document.getElementById("__tes104_hud");
        if (!el) {
          el = document.createElement("div");
          el.id = "__tes104_hud";
          el.style.cssText =
            "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;" +
            "font:600 15px/1.35 ui-monospace,monospace;padding:8px 14px;white-space:pre-wrap;";
          document.body.append(el);
        }
        const bg = { info: "#1e3a5f", pass: "#14532d", fail: "#7f1d1d" }[tone];
        el.style.background = bg;
        el.style.color = "#fff";
        el.textContent = `TES-104 · ${label} · ${text}`;
      },
      [text, tone, label],
    );
  }
};

const settingsVisible = async (visible) => {
  await win.evaluate((v) => {
    const w = window.require("@electron/remote").getCurrentWindow();
    if (v) w.setBounds({ x: 40, y: 20, width: 1200, height: 760 });
    else w.setPosition(3000, 0);
    if (v) w.focus();
  }, visible);
  await sleep(300);
};

const topModal = () => win.locator(".modal-container").last().locator(".modal");
const rowIn = (scope, page, name) =>
  scope
    .locator(".setting-item")
    .filter({ has: page.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) })
    .first();
const closeAllModals = async () => {
  for (let i = 0; i < 8 && (await win.locator(".modal-container").count()); i++) {
    await win.keyboard.press("Escape");
    await sleep(250);
  }
};
const openFromSettings = async (name) => {
  await closeAllModals();
  await settingsVisible(true);
  await rowIn(win.locator(".vertical-tab-content"), win, name).locator("button").first().click();
  await sleep(500);
};
const openProfileEditor = async () => {
  await openFromSettings("Profiles");
  await topModal()
    .locator(".setting-item", { hasText: "linuxIntegratedDefault" })
    .locator('button[aria-label="Edit"]')
    .click();
  await sleep(500);
};
const openSub = async (name) => {
  await rowIn(topModal(), win, name).locator("button").first().click();
  await sleep(500);
};

const typeSlow = async (page, text) => {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(KEY_DELAY);
  }
};
const placeSingleLine = async (page, loc, pos) => {
  await loc.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await loc.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  for (let i = 0; i < pos; i++) await page.keyboard.press("ArrowRight");
  await sleep(300);
};
const placeInTextarea = async (page, loc, idx) => {
  await loc.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await loc.click();
  await loc.evaluate((el, idx) => {
    el.focus();
    el.setSelectionRange(idx, idx);
    const line = el.value.slice(0, idx).split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.scrollTop = Math.max(0, line * lh - el.clientHeight / 2);
  }, idx);
  // Let the browser scroll the caret into view (lines wrap) before measuring.
  // Nudge away and back so the caret ends where it was, even at offset 0.
  const [away, back] = idx > 0 ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
  await page.keyboard.press(away);
  await page.keyboard.press(back);
  await sleep(300);
};
const marker = async (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    el.dataset.tes104 = String(Math.random());
    return el.dataset.tes104;
  });

// One check: put the caret at `pos` (or `at` substring index for textareas),
// run `act`, and compare against the expected value and caret.
async function check({ page = win, id, field, loc, pos, textarea = false, setup, fill, act, describe, expect, scroll = false, shotName }) {
  await hud(`${field}\n${describe}`);
  await loc.waitFor({ state: "visible", timeout: 5000 });
  if (setup !== undefined) {
    await loc.click();
    await page.keyboard.press(textarea ? "Control+a" : "End");
    if (!textarea) {
      await page.keyboard.press("Shift+Home");
    }
    await page.keyboard.press("Delete");
    await typeSlow(page, setup);
    await sleep(400);
  }
  if (fill !== undefined) {
    // setup only: start from a known-valid document
    await loc.fill(typeof fill === "function" ? await fill() : fill);
    await sleep(500);
  }
  const original = await loc.inputValue();
  const p = typeof pos === "function" ? pos(original) : pos;
  if (textarea) await placeInTextarea(page, loc, p);
  else await placeSingleLine(page, loc, p);
  const tag = await marker(page);
  const scrollBefore = await loc.evaluate((el) => el.scrollTop);
  await sleep(400);
  await act(page);
  await sleep(500);
  const now = await caret(page);
  const sameEl = await page.evaluate((t) => document.activeElement?.dataset.tes104 === t, tag);
  const scrollAfter = await loc.evaluate((el) => el.scrollTop);
  if (shotName) shot(shotName);
  const exp = expect(original, p);
  const valueOk = now.value === exp.value;
  const caretOk = now.start === null || (now.start === exp.caret && now.end === exp.caret);
  const scrollOk = !scroll || Math.abs(scrollAfter - scrollBefore) <= 2;
  const pass = valueOk && caretOk && sameEl && scrollOk;
  const r = {
    id, field, action: describe, inputType: now.type ?? now.tag?.toLowerCase(),
    original, expectedValue: exp.value, actualValue: now.value,
    expectedCaret: exp.caret, actualCaret: now.start === null ? "n/a (number input)" : [now.start, now.end],
    focusKept: sameEl, ...(scroll ? { scrollBefore, scrollAfter } : {}), pass,
  };
  results.push(r);
  const shown = (s) => JSON.stringify(s.length > 48 ? "…" + s.slice(Math.max(0, exp.caret - 20), exp.caret + 20) + "…" : s);
  await hud(
    `${field}\n${describe}\nexpected ${shown(exp.value)} caret ${exp.caret}  →  got ${shown(now.value)} caret ${now.start ?? "(n/a)"}${scroll ? `  scroll ${scrollBefore}→${scrollAfter}` : ""}  ${pass ? "PASS" : "FAIL"}`,
    pass ? "pass" : "fail",
  );
  await sleep(1400);
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${field}: ${JSON.stringify(r)}`);
  return r;
}
const insertAt = (text) => (o, p) => ({ value: o.slice(0, p) + text + o.slice(p), caret: p + text.length });
const typing = (text) => (page) => typeSlow(page, text);
const shot = (name) =>
  execFileSync("ffmpeg", ["-v", "error", "-f", "x11grab", "-video_size", "1280x800", "-i", ":99", "-frames:v", "1", "-y", `${outDir}/${name}.png`], { env: { ...process.env, DISPLAY: ":99" } });

// ── Settings tab ───────────────────────────────────────────────────────────
await closeAllModals();
await settingsVisible(true);
const tab = win.locator(".vertical-tab-content");
for (const [id, name] of [["S1", "Notice timeout \\(s\\)"], ["S2", "Error notice timeout \\(s\\)"]]) {
  await check({
    page: win, id, field: `Settings ▸ ${name.replace(/\\/g, "")}`,
    loc: rowIn(tab, win, name).locator("input"), pos: 0,
    describe: "caret at start, type 12", act: typing("12"), expect: insertAt("12"),
  });
}

// ── Plugin-wide Terminal options modal ─────────────────────────────────────
await openFromSettings("Terminal options");
const tOpt = (name, sel = "input") => rowIn(topModal(), win, name).locator(sel).first();
await check({ id: "T1", field: "Terminal options ▸ Font family", loc: tOpt("Font family"), setup: "monospace", pos: 4,
  describe: "value monospace, caret after 'mono', type XY", act: typing("XY"), expect: insertAt("XY") });
await check({ id: "T2", field: "Terminal options ▸ Font size (number)", loc: tOpt("Font size"), setup: "14", pos: 1,
  describe: "value 14, caret after '1', type 23", act: typing("23"), expect: insertAt("23") });
await check({ id: "T3", field: "Terminal options ▸ Font weight", loc: tOpt("Font weight"), setup: "400", pos: 1,
  describe: "value 400, caret after '4', type 12", act: typing("12"), expect: insertAt("12") });
await check({ id: "T4", field: "Terminal options ▸ Bold font weight", loc: tOpt("Bold font weight"), setup: "700", pos: 1,
  describe: "value 700, caret after '7', type 12", act: typing("12"), expect: insertAt("12") });
const json = tOpt("Data", "textarea");
await check({ id: "T5", field: "Terminal options ▸ Data (raw JSON)", loc: json, textarea: true, fill: '{\n  "documentOverride": null,\n  "fontFamily": "monospace"\n}', shotName: "terminal-options-json",
  pos: (o) => o.indexOf('"fontFamily": "') + '"fontFamily": "'.length + 4,
  describe: "caret inside the fontFamily string, 4 chars in, type ZW (stays valid JSON)", act: typing("ZW"), expect: insertAt("ZW") });
const fontField = await tOpt("Font family").inputValue();
let fontJson;
try { fontJson = JSON.parse(await json.inputValue()).fontFamily; } catch { fontJson = "(raw JSON is invalid)"; }
results.push({ id: "T7", field: "Terminal options ▸ Font family", action: "dedicated field reflects raw JSON edit",
  expectedValue: fontJson, actualValue: fontField, pass: fontField === fontJson });
console.log(`${fontField === fontJson ? "PASS" : "FAIL"} T7 font field after JSON edit: ${fontField}`);
await hud(`Terminal options ▸ Font family\nfield after the JSON edit: ${JSON.stringify(fontField)}, JSON fontFamily: ${JSON.stringify(fontJson)}  ${fontField === fontJson ? "PASS" : "FAIL"}`, fontField === fontJson ? "pass" : "fail");
await sleep(1500);
await check({ id: "T6", field: "Terminal options ▸ Data (raw JSON)", loc: json, textarea: true, fill: '{\n  "documentOverride": null,\n  "fontFamily": "monospace"\n}',
  pos: (o) => o.indexOf('"fontFamily": "') + '"fontFamily": "'.length + 4,
  describe: "type \" (invalid JSON), then Backspace (valid again)",
  act: async (page) => { await typeSlow(page, "\""); await page.keyboard.press("Backspace"); await sleep(KEY_DELAY); },
  expect: (o, p) => ({ value: o, caret: p }) });
// Nested-quote round trip (font-family guidance acceptance criteria).
const css = "'0xProto Nerd Font Mono', monospace";
await hud("Terminal options ▸ Font family\nround trip: CSS list with nested quotes and a fallback");
const ff = tOpt("Font family");
await ff.click();
await win.keyboard.press("End");
await win.keyboard.press("Shift+Home");
await win.keyboard.type(css, { delay: 40 });
await sleep(700);
const jsonText = await json.inputValue();
const roundTripOk = jsonText.includes(`"fontFamily": ${JSON.stringify(css)}`) && (await ff.inputValue()) === css;
results.push({ id: "T8", field: "Terminal options ▸ Font family ⇄ Data", action: `type ${css} in field; JSON keeps it verbatim`,
  expectedValue: `"fontFamily": ${JSON.stringify(css)}`, actualValue: jsonText.match(/"fontFamily": .*/)?.[0], pass: roundTripOk });
await hud(`Terminal options ▸ Font family ⇄ Data\nJSON shows ${jsonText.match(/"fontFamily": .*/)?.[0]}  ${roundTripOk ? "PASS" : "FAIL"}`, roundTripOk ? "pass" : "fail");
shot("terminal-options-font-family");
await sleep(1500);

// ── All settings ▸ Edit (large JSON, scroll position) ──────────────────────
await openFromSettings("All settings");
const all = rowIn(topModal(), win, "Data").locator("textarea");
await check({ id: "A2", field: "All settings ▸ Data (raw JSON, scrolled)", loc: all, textarea: true, scroll: true,
  pos: (o) => o.indexOf('"noticeTimeout": ') + '"noticeTimeout": '.length,
  describe: "caret before the noticeTimeout digits, type 9 then 8 (each keystroke valid)", act: typing("98"), expect: insertAt("98"), shotName: "all-settings-json" });

await check({ id: "A1", field: "All settings ▸ Data (raw JSON, scrolled)", loc: all, textarea: true, scroll: true,
  // Valid, and different from the text the modal first rendered.
  fill: () => c.main.evaluate(() => {
    const value = structuredClone(app.plugins.plugins.terminal.settings.value);
    value.noticeTimeout = 77;
    return JSON.stringify(value, null, 2);
  }),
  pos: (o) => o.indexOf('"openChangelogOnUpdate": ') + '"openChangelogOnUpdate": '.length - 2,
  describe: "caret mid-document after the key name, type _x then Backspace×2 (valid again)",
  act: async (page) => { await typeSlow(page, "_x"); await page.keyboard.press("Backspace"); await sleep(KEY_DELAY); await page.keyboard.press("Backspace"); await sleep(KEY_DELAY); },
  expect: (o, p) => ({ value: o, caret: p }) });

// ── Profile editor (linuxIntegratedDefault) ────────────────────────────────
await openProfileEditor();
const pRow = (name, sel = "input") => rowIn(topModal(), win, name).locator(sel).first();
await check({ id: "P1", field: "Profile ▸ Name", loc: pRow("Name"), setup: "Linux", pos: 0,
  describe: "value Linux, caret at start, type 'My '", act: typing("My "), expect: insertAt("My ") });
await check({ id: "P2", field: "Profile ▸ Executable", loc: pRow("Executable"), pos: 0,
  describe: "value /bin/sh, caret at start, type /usr", act: typing("/usr"), expect: insertAt("/usr") });
await check({ id: "P3", field: "Profile ▸ Python executable", loc: pRow("Python executable"), pos: 0,
  describe: "value python3, caret before 'p', type 'uvx ' (the recorded scenario)", act: typing("uvx "), expect: insertAt("uvx "), shotName: "profile-python-executable" });
await check({ id: "P4", field: "Profile ▸ Python executable", loc: pRow("Python executable"), pos: 4,
  describe: "caret after 'uvx ', Backspace then type ' ' (delete mid-value)",
  act: async (page) => { await page.keyboard.press("Backspace"); await sleep(KEY_DELAY); await typeSlow(page, " "); },
  expect: (o, p) => ({ value: o, caret: p }) });
await check({ id: "P5", field: "Profile ▸ Python executable", loc: pRow("Python executable"), pos: 4,
  describe: "caret after 'uvx ', paste ~/.venv/bin/ with Ctrl+V",
  act: async (page) => { await page.evaluate(() => window.require("electron").clipboard.writeText("~/.venv/bin/")); await page.keyboard.press("Control+v"); await sleep(KEY_DELAY); },
  expect: insertAt("~/.venv/bin/") });
await check({ id: "P6", field: "Profile ▸ Python executable", loc: pRow("Python executable"), pos: 4,
  describe: "select '~/.venv/bin/' (Shift+→×12) and type /opt/ to replace it",
  act: async (page) => { for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight"); await sleep(300); await typeSlow(page, "/opt/"); },
  expect: (o, p) => ({ value: o.slice(0, p) + "/opt/" + o.slice(p + 12), caret: p + 5 }) });

await openSub("Data");
await check({ id: "P7", field: "Profile ▸ Data (raw JSON)", loc: rowIn(topModal(), win, "Data").locator("textarea"), textarea: true,
  pos: (o) => o.indexOf('"executable": "') + '"executable": "'.length,
  describe: "caret at the start of the executable string, type /opt (stays valid JSON)", act: typing("/opt"), expect: insertAt("/opt") });
await win.keyboard.press("Escape"); await sleep(300);

await openSub("Terminal options");
await check({ id: "P8", field: "Profile ▸ Terminal options ▸ Font family", loc: tOpt("Font family"), setup: "mono", pos: 0,
  describe: "value mono, caret at start, type ui-", act: typing("ui-"), expect: insertAt("ui-") });
await win.keyboard.press("Escape"); await sleep(300);

await openSub("Success exit codes");
await check({ id: "P9", field: "Profile ▸ Success exit codes ▸ 1st", loc: topModal().locator("input:visible, textarea:visible").first(), pos: 0,
  describe: "value 0, caret at start, type 13", act: typing("13"), expect: insertAt("13") });
await win.keyboard.press("Escape"); await sleep(300);

await openSub("Arguments");
await topModal().locator('button[aria-label="Append"]').click(); await sleep(400);
await check({ id: "P10", field: "Profile ▸ Arguments ▸ 1st", loc: topModal().locator("input:visible, textarea:visible").first(), setup: "--login", pos: 2,
  describe: "value --login, caret after '--', type no-", act: typing("no-"), expect: insertAt("no-") });
await win.keyboard.press("Escape"); await sleep(300);

await openSub("Environment variables");
await topModal().locator('button[aria-label="Append"]').click(); await sleep(400);
const envBox = topModal().locator("textarea:visible");
await check({ id: "P11", field: "Profile ▸ Environment variables ▸ key", loc: envBox.nth(0), setup: "PATH", pos: 0,
  describe: "key PATH, caret at start, type MY_", act: typing("MY_"), expect: insertAt("MY_") });
await check({ id: "P12", field: "Profile ▸ Environment variables ▸ value", loc: envBox.nth(1), setup: "/bin", pos: 0,
  describe: "value /bin, caret at start, type /usr", act: typing("/usr"), expect: insertAt("/usr") });

// ── Keymappings ────────────────────────────────────────────────────────────
for (const [id, item, sel, pos, text, what] of [
  ["K1", "PageUp", 'input[type="number"]', 1, "20", "number arg -1, caret after '-', type 20"],
  ["K2", "Shift+Enter", "textarea", 0, "ab", "string arg, caret at start, type ab"],
]) {
  await openFromSettings("Keymappings");
  await topModal().locator(".setting-item", { hasText: new RegExp(`^${item.replace("+", "\\+")}`) }).first().locator('button[aria-label="Edit"]').click();
  await sleep(500);
  await check({ id, field: `Keymappings ▸ ${item} ▸ argument`, loc: topModal().locator(sel).first(), pos, textarea: sel === "textarea",
    describe: what, act: typing(text), expect: insertAt(text) });
}

await closeAllModals();
await settingsVisible(true);
const passed = results.filter((r) => r.pass).length;
await hud(`${passed}/${results.length} checks passed`, passed === results.length ? "pass" : "fail");
await sleep(2500);
writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2));
console.log(`SUMMARY ${label}: ${passed}/${results.length} passed`);
await c.browser.close();
