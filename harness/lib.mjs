// Shared helpers for driving Obsidian over CDP.
import { chromium } from "playwright-core";

export async function connect() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const main = pages().find((p) => p.url().startsWith("app://"));
  return { browser, pages, main };
}

export async function trustAndTheme(main) {
  const trust = main.getByText("Trust author and enable plugins");
  if (await trust.count()) await trust.click();
  await main.waitForTimeout(2500);
  await main.evaluate(() => {
    app.changeTheme("obsidian");
    window
      .require("@electron/remote")
      .getCurrentWindow()
      .setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  });
}

// Opens Settings → Terminal and returns the settings window page.
export async function openTerminalSettings({ main, pages }) {
  await main.evaluate(() => {
    app.setting.open();
    app.setting.openTabById("terminal");
  });
  let win;
  for (let i = 0; i < 50 && !win; i++) {
    await main.waitForTimeout(200);
    for (const p of pages()) {
      if ((await p.title()).startsWith("Settings")) win = p;
    }
  }
  await win.evaluate(() => {
    window
      .require("@electron/remote")
      .getCurrentWindow()
      .setBounds({ x: 40, y: 20, width: 1200, height: 760 });
  });
  await win.waitForTimeout(800);
  return win;
}

// Reads the focused text control's value and selection.
export async function caret(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    let start = null,
      end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      /* input types without selection */
    }
    return {
      tag: el?.tagName,
      type: el?.type,
      value: el?.value,
      start,
      end,
      scrollTop: el?.scrollTop,
    };
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
