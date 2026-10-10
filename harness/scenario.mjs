// The recorded TES-104 scenario: profile editor ▸ Python executable, caret
// before "p", type "uvx " one key at a time. Prints the field's on-screen box.
import { connect, trustAndTheme, openTerminalSettings, caret, sleep } from "./lib.mjs";

const label = process.argv[2];
const c = await connect();
await trustAndTheme(c.main);
const win = await openTerminalSettings(c);
const row = (scope, name) =>
  scope
    .locator(".setting-item")
    .filter({ has: win.locator(".setting-item-name", { hasText: new RegExp(`^${name}$`) }) })
    .first();
await row(win.locator(".vertical-tab-content"), "Profiles").locator("button").first().click();
await sleep(500);
const modal = () => win.locator(".modal-container").last().locator(".modal");
await modal().locator(".setting-item", { hasText: "linuxIntegratedDefault" }).locator('button[aria-label="Edit"]').click();
await sleep(600);
const input = row(modal(), "Python executable").locator("input");
await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
await win.evaluate((label) => {
  const el = document.createElement("div");
  el.id = "__tes104_hud";
  el.style.cssText =
    "position:fixed;left:0;right:0;top:0;z-index:2147483647;pointer-events:none;" +
    "font:700 16px/1.4 ui-monospace,monospace;padding:6px 12px;background:#1e3a5f;color:#fff";
  el.textContent = label;
  document.body.append(el);
}, label);
const box = await input.boundingBox();
const winBox = await win.evaluate(() => window.require("@electron/remote").getCurrentWindow().getContentBounds());
console.log(`BOX ${Math.round(winBox.x + box.x)} ${Math.round(winBox.y + box.y)} ${Math.round(box.width)} ${Math.round(box.height)}`);
await input.click();
await win.keyboard.press("End");
await win.keyboard.press("Home");
await sleep(1500);
const log = [];
for (const ch of "uvx ") {
  await win.keyboard.type(ch);
  await sleep(900);
  const now = await caret(win);
  log.push(`typed ${JSON.stringify(ch)} → ${JSON.stringify(now.value)} caret ${now.start}`);
}
await sleep(1500);
console.log(log.join("\n"));
await c.browser.close();
