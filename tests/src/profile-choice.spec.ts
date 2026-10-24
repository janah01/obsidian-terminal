/**
 * Unit tests for `src/profile-choice.ts`: a device's default profile and
 * profile order, and how the first start of this version takes them over.
 */
import type { Platform } from "@polyipseity/obsidian-plugin-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceDefaultProfile,
  deviceDefaultProfileId,
  deviceProfileEntries,
  migrateProfileChoice,
} from "../../src/profile-choice.js";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import { pythonSettingsContext } from "../fixtures/python-settings-ui.js";

const platform = vi.hoisted((): { current: Platform.All } => ({
  current: "darwin",
}));
vi.mock("@polyipseity/obsidian-plugin-library", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@polyipseity/obsidian-plugin-library")
    >();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get CURRENT() {
        return platform.current;
      },
    },
  };
});

const integrated = Settings.Profile.DEFAULTS.integrated,
  // data.json; this device is a Mac.
  synced = {
    defaultProfile: "zsh",
    profiles: {
      pwsh: { ...integrated, name: "pwsh", platforms: { win32: true } },
      zsh: { ...integrated, name: "zsh", platforms: { darwin: true } },
      bash: { ...integrated, name: "bash", platforms: { darwin: true } },
    },
  },
  // Local settings as 3.29.0 writes them: no default profile, no order.
  released3290 = {
    recovery: {},
    hasUsedIntegratedTerminal: true,
    lastReadChangelogVersion: "3.29.0",
  };

/** A plugin with data.json `initial` and this device's store `local`. */
async function deviceContext(initial: unknown, local: unknown) {
  const context = await pythonSettingsContext(initial);
  Object.assign(context.localSettings, {
    value: LocalSettings.fix(local).value,
  });
  return {
    context,
    mutate: vi.spyOn(context.localSettings, "mutate"),
    write: vi.spyOn(context.localSettings, "write"),
    writeSettings: vi.spyOn(context.settings, "write"),
  };
}

afterEach(() => {
  platform.current = "darwin";
  vi.restoreAllMocks();
});

describe("first start of this version", () => {
  it("takes over the default profile of data.json when it runs on this device", async () => {
    const { context, write, writeSettings } = await deviceContext(
      synced,
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toMatchObject({
      ...released3290,
      defaultProfile: "zsh",
      profileOrder: ["pwsh", "zsh", "bash"],
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeSettings).not.toHaveBeenCalled();
    expect(context.settings.value.defaultProfile).toBe("zsh");
  });

  it("starts without a default profile when the one in data.json does not run here", async () => {
    const { context } = await deviceContext(
      { ...synced, defaultProfile: "pwsh" },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
    expect(context.localSettings.value.profileOrder).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
  });

  it("starts without a default profile when data.json has none", async () => {
    const { context } = await deviceContext(
      { ...synced, defaultProfile: null },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
  });

  it("never takes over a property that every object inherits", async () => {
    const { context } = await deviceContext(synced, released3290);
    // The settings fixer drops such an id; a value in memory is checked too.
    Object.assign(context.settings, {
      value: { ...context.settings.value, defaultProfile: "constructor" },
    });
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBeNull();
  });

  it("takes the default profile on Windows from the same data.json", async () => {
    platform.current = "win32";
    const { context } = await deviceContext(
      { ...synced, defaultProfile: "pwsh" },
      released3290,
    );
    await migrateProfileChoice(context);
    expect(context.localSettings.value.defaultProfile).toBe("pwsh");
  });

  it("leaves a new or cleared store alone", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { context, mutate, write } = await deviceContext(synced, null);
    await migrateProfileChoice(context);
    expect(mutate).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: null,
      profileOrder: [],
    });
  });

  it("runs once", async () => {
    const { context, write } = await deviceContext(synced, released3290);
    await migrateProfileChoice(context);
    await migrateProfileChoice(context);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("takes over only what the store lacks", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "bash",
    });
    await migrateProfileChoice(context);
    expect(context.localSettings.value).toMatchObject({
      defaultProfile: "bash",
      profileOrder: ["pwsh", "zsh", "bash"],
    });
  });

  it("keeps the choice for this session when the store cannot be written", async () => {
    const { context, write } = await deviceContext(synced, released3290),
      error = new Error("QuotaExceededError"),
      logged = vi.spyOn(console, "error").mockImplementation(() => {});
    write.mockRejectedValueOnce(error);
    await expect(migrateProfileChoice(context)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith(error);
    expect(context.localSettings.value.defaultProfile).toBe("zsh");
  });
});

describe("this device's default profile and order", () => {
  it("reads a store that 3.29.0 wrote as no choice, in the order of data.json", async () => {
    const { context } = await deviceContext(synced, released3290);
    expect(deviceDefaultProfileId(context)).toBeNull();
    expect(deviceDefaultProfile(context)).toBeNull();
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "pwsh",
      "zsh",
      "bash",
    ]);
  });

  it("lists the profiles in this device's order", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      profileOrder: ["bash", "gone", "pwsh"],
    });
    expect(deviceProfileEntries(context).map(([id]) => id)).toEqual([
      "bash",
      "pwsh",
      "zsh",
    ]);
  });

  it("opens this device's default, not the one in data.json", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "bash",
    });
    expect(deviceDefaultProfile(context)).toEqual([
      "bash",
      synced.profiles.bash,
    ]);
  });

  it("ignores a default profile deleted on another device", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "gone",
    });
    expect(deviceDefaultProfileId(context)).toBeNull();
    expect(deviceDefaultProfile(context)).toBeNull();
  });

  it("keeps a default that does not run here but does not open it", async () => {
    const { context } = await deviceContext(synced, {
      ...released3290,
      defaultProfile: "pwsh",
    });
    expect(deviceDefaultProfileId(context)).toBe("pwsh");
    expect(deviceDefaultProfile(context)).toBeNull();
  });

  it.each(["constructor", "__proto__", "toString"])(
    "never takes the inherited property %s for a default",
    async (id) => {
      const { context } = await deviceContext(synced, {
        ...released3290,
        defaultProfile: id,
      });
      expect(deviceDefaultProfileId(context)).toBeNull();
      expect(deviceDefaultProfile(context)).toBeNull();
    },
  );
});
