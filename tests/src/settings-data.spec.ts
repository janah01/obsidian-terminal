/**
 * Unit tests for `src/settings-data.ts` — validate defaults and normalization helpers.
 */
import { cloneAsWritable } from "@polyipseity/obsidian-plugin-library";
import { describe, expect, it, vi } from "vitest";
import { expectTypeOf } from "vitest";
import { LocalSettings, Settings } from "../../src/settings-data.js";
import { PROFILE_PRESETS } from "../../src/terminal/profile-presets.js";
import { inheritedPythonExecutable } from "../../src/terminal/win32-doctor.js";
import released328 from "../fixtures/data-3.28.0.json" with { type: "json" };
import released329 from "../fixtures/data-3.29.0.json" with { type: "json" };
import {
  type PluginContext,
  SettingsManager,
  StorageSettingsManager,
} from "@polyipseity/obsidian-plugin-library";
import { isEqual } from "es-toolkit/predicate";

// Literal presets from 3.27.2 (a485e98b05f2dc0bc14e0a9d92c3d8cad6d0a95f),
// src/terminal/profile-presets.ts and constants from src/magic.ts.
// These released records predate win32Backend. 3.27.0 and 3.27.1 presets omitted
// environment; 3.27.2 added environment: [] (50aaa931).
// The generic integrated default used an empty Python
// executable, whereas these Windows-only and cross-platform presets used python3.
const RELEASED_3_27_2_PROFILES = {
  cmdIntegrated: {
    args: [],
    environment: [],
    executable: "C:\\Windows\\System32\\cmd.exe",
    followTheme: true,
    name: "",
    platforms: { win32: true },
    pythonExecutable: "python3",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: ["0", "SIGINT", "SIGTERM"],
    terminalOptions: { documentOverride: null },
    type: "integrated",
    useWin32Conhost: true,
  },
  pwshIntegrated: {
    args: [],
    environment: [],
    executable: "pwsh",
    followTheme: true,
    name: "",
    platforms: { darwin: true, linux: true, win32: true },
    pythonExecutable: "python3",
    restoreHistory: false,
    rightClickAction: "copyPaste",
    successExitCodes: ["0", "SIGINT", "SIGTERM"],
    terminalOptions: { documentOverride: null },
    type: "integrated",
    useWin32Conhost: true,
  },
};

describe("src/settings-data.ts", () => {
  it("Settings.DEFAULT has expected keys and types", () => {
    expect(Settings.DEFAULT).toHaveProperty("noticeTimeout");
    expect(typeof Settings.DEFAULT.noticeTimeout).toBe("number");
    expect(Settings.DEFAULT).toHaveProperty("openChangelogOnUpdate");
    expect(typeof Settings.DEFAULT.openChangelogOnUpdate).toBe("boolean");
    expect(Settings.DEFAULT).toHaveProperty("showTerminalTabPrefix");
    expect(Settings.DEFAULT.showTerminalTabPrefix).toBe(false);
    expect(Settings.DEFAULT).toHaveProperty("terminalOptions");
    expect(typeof Settings.DEFAULT.terminalOptions).toBe("object");
    // should at least include the documentOverride property from the preset
    expect(
      Object.prototype.hasOwnProperty.call(
        Settings.DEFAULT.terminalOptions,
        "documentOverride",
      ),
    ).toBe(true);
  });

  it("DEFAULTABLE_LANGUAGES includes empty string and is an array", () => {
    expect(Array.isArray(Settings.DEFAULTABLE_LANGUAGES)).toBe(true);
    expect(Settings.DEFAULTABLE_LANGUAGES).toContain("");
  });

  it("Settings.fix coerces bad typed values to defaults", () => {
    // provide clearly wrong types including terminalOptions
    const bad = {
      errorNoticeTimeout: "not-a-number",
      language: "invalid-language",
      noticeTimeout: "x",
      openChangelogOnUpdate: "truthy",
      terminalOptions: "not-an-object",
    };
    const fixed = Settings.fix(bad);
    expect(typeof fixed.value.noticeTimeout).toBe("number");
    expect(typeof fixed.value.openChangelogOnUpdate).toBe("boolean");
    // invalid options should be replaced with DEFAULT
    expect(fixed.value.terminalOptions).toEqual(
      Settings.DEFAULT.terminalOptions,
    );
  });

  it("keeps every number the number fields store, through a save and a load", () => {
    // The fields store what is typed: a minus sign, an exponent, a decimal.
    // A device on 3.29.0 reads them with these same fixers.
    const [key, profile] = Object.entries(released329.profiles)[0] ?? [];
    if (!key || !profile) throw new Error("fixture has no profile");
    const typed = {
        ...released329,
        errorNoticeTimeout: -1,
        noticeTimeout: 0.001,
        profiles: {
          ...released329.profiles,
          [key]: { ...profile, terminalOptions: { fontSize: 14.05 } },
        },
        terminalOptions: { ...released329.terminalOptions, fontSize: 1000 },
      },
      fixed = Settings.fix(JSON.parse(JSON.stringify(typed)));

    expect(fixed.valid).toBe(true);
    expect(fixed.value).toMatchObject({
      errorNoticeTimeout: -1,
      noticeTimeout: 0.001,
      profiles: { [key]: { terminalOptions: { fontSize: 14.05 } } },
      terminalOptions: { fontSize: 1000 },
    });
  });

  it.each([
    undefined,
    null,
    {},
    "bad",
    { hasUsedIntegratedTerminal: "true" },
    { hasUsedIntegratedTerminal: 1 },
    { hasUsedIntegratedTerminal: null },
  ])("defaults local integrated-terminal use to false for %j", (stored) => {
    expect(LocalSettings.fix(stored).value).toHaveProperty(
      "hasUsedIntegratedTerminal",
      false,
    );
  });

  it.each([false, true])(
    "preserves local integrated-terminal use %s through JSON",
    (used) => {
      const first = LocalSettings.fix({ hasUsedIntegratedTerminal: used }),
        stored: unknown = JSON.parse(JSON.stringify(first.value));
      expect(LocalSettings.fix(stored)).toMatchObject({
        valid: true,
        value: { hasUsedIntegratedTerminal: used },
      });
      expect(Settings.DEFAULT).not.toHaveProperty("hasUsedIntegratedTerminal");
    },
  );

  it("LocalSettings survives a JSON persistence round trip as valid", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    // `StorageSettingsManager.write` persists `JSON.stringify(value)`, which
    // drops undefined-valued keys. The next load must not flag that stored
    // shape as malformed, or every startup appends a recovery entry.
    const first = LocalSettings.fix(null),
      stored: unknown = JSON.parse(JSON.stringify(first.value));
    expect(LocalSettings.fix(stored).valid).toBe(true);
  });

  it("LocalSettings.fix keeps the marker of local settings that could not be read", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const { FAILED, hasFailed } = StorageSettingsManager;
    // The changelog check at startup skips such settings, or the changelog
    // would open on every start.
    expect(hasFailed(LocalSettings.fix({ [FAILED]: true }).value)).toBe(true);
    expect(hasFailed(LocalSettings.fix({}).value)).toBe(false);
  });

  describe("local settings whose storage key is not found", () => {
    // The key needs a private API of Obsidian, which may change.
    function failingLocalSettings(): {
      readonly getItem: ReturnType<typeof vi.fn>;
      readonly manager: StorageSettingsManager<LocalSettings>;
      readonly setItem: ReturnType<typeof vi.fn>;
    } {
      const getItem = vi.fn(),
        setItem = vi.fn(),
        context = {
          app: {
            get appId(): never {
              throw new Error("appId is gone");
            },
          },
          language: {
            onLoaded: Promise.resolve(),
            value: { t: (key: string): string => key },
          },
          manifest: { id: "terminal" },
        } as unknown as PluginContext,
        manager = new StorageSettingsManager(context, LocalSettings.fix, {
          getItem,
          setItem,
        } as unknown as Storage);
      return { getItem, manager, setItem };
    }

    it("load with the marker, the defaults and no report", async () => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {}),
        warn = vi.spyOn(console, "warn").mockImplementation(() => {}),
        errors = vi.spyOn(console, "error").mockImplementation(() => {}),
        { getItem, manager, setItem } = failingLocalSettings();
      manager.load();
      try {
        await manager.onLoaded;
        await manager.write();

        expect(warn).toHaveBeenCalledWith(
          "errors.private-API-changed",
          expect.any(Error),
        );
        expect(StorageSettingsManager.hasFailed(manager.value)).toBe(true);
        expect(manager.value).toMatchObject({
          hasUsedIntegratedTerminal: false,
          lastReadChangelogVersion:
            LocalSettings.fix(null).value.lastReadChangelogVersion,
          recovery: {},
        });
        expect(errors).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
      } finally {
        manager.unload();
        for (const spy of [debug, warn, errors]) {
          spy.mockRestore();
        }
      }
    });

    it("keep the marker when data.json is malformed on the same start", async () => {
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {}),
        warn = vi.spyOn(console, "warn").mockImplementation(() => {}),
        errors = vi.spyOn(console, "error").mockImplementation(() => {}),
        { manager: localSettings } = failingLocalSettings(),
        // As `main.ts` makes it, over a data.json with a wrong value.
        settings = new SettingsManager(
          {
            language: {
              onLoaded: Promise.resolve(),
              value: { t: (key: string): string => key },
            },
            loadData: vi.fn().mockResolvedValue({ noticeTimeout: "5" }),
            localSettings,
            saveData: vi.fn(),
          } as unknown as PluginContext,
          Settings.fix,
        );
      localSettings.load();
      settings.load();
      try {
        // `main.ts` waits for both before the changelog check.
        await Promise.all([localSettings.onLoaded, settings.onLoaded]);

        expect(errors.mock.calls[0]?.[0]).toBe("errors.malformed-data");
        expect(StorageSettingsManager.hasFailed(localSettings.value)).toBe(
          true,
        );
      } finally {
        settings.unload();
        localSettings.unload();
        for (const spy of [debug, warn, errors]) {
          spy.mockRestore();
        }
      }
    });
  });

  it("LocalSettings.fix ensures lastReadChangelogVersion exists and is a string", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fixed = LocalSettings.fix({});
    expect(fixed.value).toHaveProperty("lastReadChangelogVersion");
    expect(typeof fixed.value.lastReadChangelogVersion).toBe("string");

    // semver parsing of an undefined value will be logged via opaqueOrDefault()
    const [debugCall] = debugSpy.mock.calls;
    expect(debugCall?.[0]).toHaveProperty(
      "message",
      expect.stringContaining("Invalid Version: undefined"),
    );
  });

  it("Profile.DEFAULTS exposes an empty environment for shell profiles", () => {
    expect(Settings.Profile.DEFAULTS.external.environment).toEqual([]);
    expect(Settings.Profile.DEFAULTS.integrated.environment).toEqual([]);
  });

  it("Profile.fix coerces a bad environment to the empty default", () => {
    const external = Settings.Profile.fix({
      type: "external",
      environment: "not-an-array",
    }).value;
    expect(external.type).toBe("external");
    expect((external as Settings.Profile.External).environment).toEqual([]);

    const integrated = Settings.Profile.fix({
      type: "integrated",
      environment: [["FOO", "bar"]],
    }).value;
    expect((integrated as Settings.Profile.Integrated).environment).toEqual([
      ["FOO", "bar"],
    ]);
  });

  it("Profile.fix drops invalid environment entries silently", () => {
    // Old string format entries and malformed entries should be dropped,
    // not crash the fix function.
    const result = Settings.Profile.fix({
      type: "external",
      environment: ["FOO=bar", ["KEY", "value"], [42, "value"], ["KEY"]],
    }).value;
    expect((result as Settings.Profile.External).environment).toEqual([
      ["KEY", "value"],
    ]);
  });

  it("Profile.fix reports a value without a known type as malformed", () => {
    // Such a value becomes an invalid profile that keeps every key it has,
    // so the profile editor must not import it over a profile.
    for (const value of [{}, { name: "x" }, { noticeTimeout: 5 }]) {
      const fixed = Settings.Profile.fix(value);
      expect(fixed.value).toEqual({ ...value, type: "invalid" });
      expect(fixed.valid).toBe(false);
    }
    expect(Settings.Profile.fix({ type: "unknown" }).valid).toBe(false);
    const invalid = { name: "x", type: "invalid" };
    expect(Settings.Profile.fix(invalid).value).toEqual(invalid);
    expect(Settings.Profile.fix(invalid).valid).toBe(true);
  });

  it("normalizes the Windows backend selector", () => {
    // Presentation order for the profile editor; the default is ConPTY.
    expect(Settings.Profile.WIN32_BACKENDS).toEqual(["conpty", "legacy"]);
    expect(Settings.Profile.DEFAULTS.integrated.win32Backend).toBe("conpty");
    const conpty = Settings.Profile.fix({
        type: "integrated",
        win32Backend: "conpty",
      }).value,
      legacy = Settings.Profile.fix({
        type: "integrated",
        win32Backend: "legacy",
      }).value;
    expect(conpty).toMatchObject({
      type: "integrated",
      win32Backend: "conpty",
    });
    expect(legacy).toMatchObject({
      type: "integrated",
      win32Backend: "legacy",
    });
    expect(conpty).not.toHaveProperty("useWin32Conhost");
    expect(legacy).not.toHaveProperty("useWin32Conhost");
  });

  it("rejects unknown Windows backend values", () => {
    expect(
      Settings.Profile.fix({
        type: "integrated",
        win32Backend: "shell-pipes",
      }).value,
    ).toMatchObject({ win32Backend: "conpty" });
  });

  // Both tuple types are written out, so that a source archive without the
  // vendored library still knows them. They must stay what `deepFreeze` made
  // of them: frozen, in the order the profile editor offers them, and
  // literal rather than widened to `string`.
  it("keeps the profile types and Windows backends frozen, ordered and literal", () => {
    expect(Settings.Profile.TYPES).toEqual([
      "",
      "invalid",
      "developerConsole",
      "external",
      "integrated",
    ]);
    expect(Object.isFrozen(Settings.Profile.TYPES)).toBe(true);
    expect(Object.isFrozen(Settings.Profile.WIN32_BACKENDS)).toBe(true);
    expectTypeOf<Settings.Profile.Type>().toEqualTypeOf<
      "" | "developerConsole" | "external" | "integrated" | "invalid"
    >();
    expectTypeOf<Settings.Profile.Win32Backend>().toEqualTypeOf<
      "conpty" | "legacy"
    >();
  });

  it.each(["", "invalid", "developerConsole", "external", "integrated"])(
    "Profile.fix keeps the profile type %j",
    (type) => {
      expect(Settings.Profile.fix({ type }).value.type).toBe(type);
    },
  );

  // For example a profile written by a newer version on another device that
  // syncs the same vault.
  it("Profile.fix makes a profile of an unknown type invalid", () => {
    expect(Settings.Profile.fix({ type: "ssh" }).value.type).toBe("invalid");
  });

  it("defaults the plugin-level Python executable to automatic discovery", () => {
    expect(Settings.DEFAULT.pythonExecutable).toBe("");
    expect(
      Settings.fix({ pythonExecutable: "C:\\Python312\\python.exe" }).value
        .pythonExecutable,
    ).toBe("C:\\Python312\\python.exe");
    expect(Settings.fix({ pythonExecutable: 42 }).value.pythonExecutable).toBe(
      "",
    );
  });

  it("defaults the Windows Terminal console host to on", () => {
    expect(Settings.DEFAULT.windowsTerminalConsoleHost).toBe(true);
    expect(Settings.fix({}).value.windowsTerminalConsoleHost).toBe(true);
  });

  it.each([true, false])(
    "keeps the Windows Terminal console host setting %j",
    (windowsTerminalConsoleHost) => {
      expect(
        Settings.fix({ windowsTerminalConsoleHost }).value
          .windowsTerminalConsoleHost,
      ).toBe(windowsTerminalConsoleHost);
    },
  );

  it.each(["false", 0, 1, null, {}])(
    "replaces the Windows Terminal console host setting %j with the default",
    (windowsTerminalConsoleHost) => {
      expect(
        Settings.fix({ windowsTerminalConsoleHost }).value
          .windowsTerminalConsoleHost,
      ).toBe(Settings.DEFAULT.windowsTerminalConsoleHost);
    },
  );

  it.each(["automatic", "system", "custom"])(
    "drops the retired console host setting %j",
    (win32ConsoleHost) => {
      const fixed = Settings.fix({ win32ConsoleHost }).value;
      expect(fixed).not.toHaveProperty("win32ConsoleHost");
      expect(fixed.windowsTerminalConsoleHost).toBe(true);
    },
  );

  it("drops the flag of the console host experiment", () => {
    // Test builds stored it as an experiment flag before it became a setting.
    const fixed = Settings.fix({
      experiments: { windowsTerminalConsoleHost: true },
    }).value;
    expect(fixed.experiments).toEqual({});
    expect(fixed.windowsTerminalConsoleHost).toBe(true);
  });

  it("drops the retired discovery marker", () => {
    // The field holds only what the user typed, so nothing marks a value as
    // discovered any more.
    expect(
      Settings.fix({
        pythonExecutable: "python",
        pythonExecutableDiscovered: true,
      }).value,
    ).not.toHaveProperty("pythonExecutableDiscovered");
  });

  it.each([
    RELEASED_3_27_2_PROFILES.cmdIntegrated.platforms,
    { darwin: false, linux: false, win32: true },
    { darwin: "false", linux: 0, win32: true },
  ])(
    "migrates released Windows-only python3 after normalizing platforms: %j",
    (platforms) => {
      const fixed = Settings.Profile.fix({
        ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
        platforms,
      });
      expect(fixed.value).toMatchObject({
        pythonExecutable: "",
        win32Backend: "conpty",
      });
    },
  );

  it.each([
    RELEASED_3_27_2_PROFILES.pwshIntegrated.platforms,
    { darwin: true, win32: true },
    { linux: true, win32: true },
    { darwin: true, linux: true },
    { win32: false },
    { win32: "true" },
    {},
  ])(
    "preserves stored python3 for profiles that are not Windows-only: %j",
    (platforms) => {
      const fixed = Settings.fix({
        pythonExecutable: "C:\\Plugin\\python.exe",
        profiles: {
          explicit: {
            ...RELEASED_3_27_2_PROFILES.pwshIntegrated,
            platforms,
          },
        },
      }).value;
      expect(fixed.profiles["explicit"]).toMatchObject({
        pythonExecutable: "python3",
      });
    },
  );

  it.each([
    { win32Backend: "conpty", expectedBackend: "conpty" },
    { win32Backend: "legacy", expectedBackend: "legacy" },
    { win32Backend: null, expectedBackend: "conpty" },
  ])(
    "preserves stored python3 with a defined backend: $win32Backend",
    ({ win32Backend, expectedBackend }) => {
      expect(
        Settings.Profile.fix({
          ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
          win32Backend,
        }).value,
      ).toMatchObject({
        pythonExecutable: "python3",
        win32Backend: expectedBackend,
      });
    },
  );

  it.each([
    "C:\\Custom\\python.exe",
    "python",
    "my-python",
    "Python3",
    " python3",
    "python3 ",
    "python3\t",
    "",
  ])(
    "preserves other legacy Python strings exactly: %j",
    (pythonExecutable) => {
      expect(
        Settings.Profile.fix({
          ...RELEASED_3_27_2_PROFILES.cmdIntegrated,
          pythonExecutable,
        }).value,
      ).toHaveProperty("pythonExecutable", pythonExecutable);
    },
  );

  it.each([false, true])(
    "keeps a current preset clone's inherited Python (missing backend: %s)",
    (missingBackend) => {
      // Match the profile editor's clone path, including a not-yet-fixed shape.
      const cloned = cloneAsWritable(PROFILE_PRESETS.cmdIntegrated),
        { win32Backend: _win32Backend, ...withoutBackend } = cloned,
        fixed = Settings.Profile.fix(missingBackend ? withoutBackend : cloned);
      expect(cloned.pythonExecutable).toBe("");
      expect(fixed.value).toEqual(cloned);
    },
  );

  describe("fixer convergence across persistence", () => {
    /*
     * A fixer key that does not round-trip stably appends one recovery
     * snapshot per load, forever. Fix → persist → fix must be a no-op.
     */
    function expectConvergence(input: unknown): Settings {
      const first = Settings.fix(input).value,
        stored: unknown = JSON.parse(JSON.stringify(first)),
        second = Settings.fix(stored);
      expect(second.valid).toBe(true);
      expect(JSON.stringify(second.value)).toBe(JSON.stringify(first));
      return first;
    }

    it.each([
      { useWin32Conhost: true, omitEnvironment: true },
      { useWin32Conhost: false, omitEnvironment: true },
      { useWin32Conhost: true, omitEnvironment: false },
      { useWin32Conhost: false, omitEnvironment: false },
    ])(
      "converges released 3.27.x settings onto ConPTY (useWin32Conhost: $useWin32Conhost, omitted environment: $omitEnvironment)",
      ({ useWin32Conhost, omitEnvironment }) => {
        // Released settings have neither plugin-level Python nor prewarm fields.
        const released = {
            addToCommand: false,
            defaultProfile: "cmdIntegrated",
            errorNoticeTimeout: 0,
            language: "",
            noticeTimeout: 17,
            profiles: Object.fromEntries(
              Object.entries(RELEASED_3_27_2_PROFILES).map(([id, profile]) => {
                const { environment: _environment, ...olderProfile } = profile;
                return [
                  id,
                  {
                    ...(omitEnvironment ? olderProfile : profile),
                    useWin32Conhost,
                  },
                ];
              }),
            ),
          },
          fixed = expectConvergence(released),
          { profiles: _profiles, ...unrelated } = released;
        expect(fixed).toMatchObject(unrelated);
        expect(Object.keys(fixed.profiles)).toEqual(
          Object.keys(released.profiles),
        );
        for (const [id, profile] of Object.entries(RELEASED_3_27_2_PROFILES)) {
          const {
            useWin32Conhost: _useWin32Conhost,
            pythonExecutable: _pythonExecutable,
            ...preserved
          } = profile;
          expect(fixed.profiles[id]).toMatchObject({
            ...preserved,
            pythonExecutable: id === "cmdIntegrated" ? "" : "python3",
            win32Backend: "conpty",
          });
          expect(fixed.profiles[id]).not.toHaveProperty("useWin32Conhost");
        }
      },
    );

    it("converges current-era data in one cycle", () => {
      expectConvergence(JSON.parse(JSON.stringify(Settings.DEFAULT)));
    });

    it("migrates once, inherits plugin Python, and preserves a later explicit python3", () => {
      // Model released profiles with a plugin path configured after upgrading.
      const input = {
          ...Settings.DEFAULT,
          defaultProfile: "cmdIntegrated",
          noticeTimeout: 17,
          profiles: RELEASED_3_27_2_PROFILES,
          pythonExecutable: "C:\\Plugin\\python.exe",
          showTerminalTabPrefix: true,
        },
        before = cloneAsWritable(input),
        fixed = expectConvergence(input),
        profile = fixed.profiles["cmdIntegrated"];
      if (profile?.type !== "integrated") {
        throw new Error("Expected an integrated profile");
      }
      expect(profile.pythonExecutable).toBe("");
      expect(
        inheritedPythonExecutable(
          profile.pythonExecutable,
          fixed.pythonExecutable,
        ),
      ).toBe(input.pythonExecutable);
      const { profiles: _profiles, ...unrelated } = input;
      expect(fixed).toMatchObject(unrelated);
      expect(input).toEqual(before);

      const edited = expectConvergence({
        ...fixed,
        profiles: {
          ...fixed.profiles,
          cmdIntegrated: { ...profile, pythonExecutable: "python3" },
        },
      });
      expect(edited.profiles["cmdIntegrated"]).toHaveProperty(
        "pythonExecutable",
        "python3",
      );
    });

    describe("experiments", () => {
      it("Settings.DEFAULT turns no experiment on", () => {
        expect(Settings.DEFAULT.experiments).toEqual({});
      });

      // One tuple per case: `it.each` spreads a bare array into arguments.
      it.each([[undefined], [null], ["x"], [3], [[]], [true]])(
        "Settings.fix defaults experiments for %j",
        (experiments) => {
          expect(Settings.fix({ experiments }).value.experiments).toEqual({});
        },
      );

      it("Settings.fix drops unknown and malformed experiment flags", () => {
        const fixed = Settings.fix({
          experiments: { gone: true, nested: { a: 1 }, other: "yes" },
        }).value;
        expect(fixed.experiments).toEqual({});
        expect(fixed.profiles).toEqual(Settings.fix({}).value.profiles);
      });

      it("a removed experiment's flag is cleaned up in one cycle", () => {
        const current = cloneAsWritable(Settings.DEFAULT),
          [id, profile] = Object.entries(current.profiles)[0] ?? [];
        if (id === undefined || profile === undefined) {
          throw new Error("Expected a default profile");
        }
        const profiles = {
            ...current.profiles,
            [id]: { ...profile, name: "My shell" },
          },
          // The flag of an experiment that has since graduated or been removed.
          fixed = expectConvergence(
            JSON.parse(
              JSON.stringify({
                ...current,
                experiments: { gone: true },
                profiles,
              }),
            ),
          );
        expect(fixed.experiments).toEqual({});
        expect(fixed.profiles).toEqual(profiles);
      });

      it("an upgrade from 3.28.0 changes no stored setting and turns nothing on", () => {
        const released: unknown = JSON.parse(JSON.stringify(released328)),
          fixed = expectConvergence(released);
        expect(released328).not.toHaveProperty("experiments");
        expect(released328.profiles.darwinIntegratedDefault.name).toBe(
          "My shell",
        );
        expect(fixed).toMatchObject(released328);
        expect(fixed.profiles).toEqual(released328.profiles);
        expect(fixed.experiments).toEqual({});
        expect(released).toEqual(released328);
      });

      it("a data.json saved by 3.28.0 is not malformed: it only lacks the new keys", () => {
        const stored: unknown = JSON.parse(JSON.stringify(released328));
        expect(Settings.fix(stored).valid).toBe(true);
      });

      it("a data.json saved by 3.29.0 loads unchanged and is not malformed", () => {
        const stored: unknown = JSON.parse(JSON.stringify(released329)),
          fixed = Settings.fix(stored);
        expect(fixed.valid).toBe(true);
        expect(fixed.value).toMatchObject(released329);
      });

      it("3.29.0 local settings with a recovery copy are not malformed", () => {
        const stored = {
            hasUsedIntegratedTerminal: true,
            lastReadChangelogVersion: "3.29.0",
            recovery: {
              "settings.2026-10-14T08:32:47.171Z": JSON.stringify(
                released328,
                null,
                2,
              ),
            },
          },
          fixed = LocalSettings.fix(JSON.parse(JSON.stringify(stored)));
        expect(fixed.valid).toBe(true);
        expect(fixed.value).toMatchObject(stored);
        expect(fixed.value.recovery).toEqual(stored.recovery);
      });
    });

    describe("data saved by an older version", () => {
      interface Loaded<T> {
        readonly errors: readonly (readonly unknown[])[];
        readonly copies: Readonly<Record<string, string>>;
        readonly written: unknown;
        readonly value: T;
      }

      function copy(value: unknown): unknown {
        const ret: unknown = JSON.parse(JSON.stringify(value));
        return ret;
      }

      // The library's manager with `Settings.fix`, as `main.ts` makes it, over
      // a context that reads `data` and keeps recovery copies in a record.
      async function loadSettings(data: unknown): Promise<Loaded<Settings>> {
        const errors = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined),
          copies: Record<string, string> = {},
          saveData = vi.fn(),
          // A stand-in for the plugin: only what the manager reads.
          context = {
            language: {
              onLoaded: Promise.resolve(),
              value: { t: (key: string): string => key },
            },
            loadData: vi.fn().mockResolvedValue(data),
            localSettings: {
              mutate: vi.fn(
                async (
                  mutator: (local: {
                    readonly recovery: Record<string, string>;
                  }) => unknown,
                ) => {
                  await mutator({ recovery: copies });
                },
              ),
              onLoaded: Promise.resolve(),
              write: vi.fn(),
            },
            saveData,
          } as unknown as PluginContext,
          manager = new SettingsManager(context, Settings.fix);
        manager.load();
        try {
          await manager.onLoaded;
          // The manager writes what it loaded back once.
          await vi.waitFor(() => {
            expect(saveData).toHaveBeenCalled();
          });
          return {
            copies,
            errors: [...errors.mock.calls],
            value: manager.value,
            written: saveData.mock.calls[0]?.[0],
          };
        } finally {
          manager.unload();
          errors.mockRestore();
        }
      }

      // The same for `LocalSettings.fix` over a store holding `stored`.
      async function loadLocalSettings(
        stored: unknown,
      ): Promise<Loaded<LocalSettings>> {
        const errors = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined),
          setItem = vi.fn(),
          storage = {
            getItem: vi.fn(() => JSON.stringify(stored)),
            setItem,
          } as unknown as Storage,
          context = {
            app: { appId: "vault" },
            language: {
              onLoaded: Promise.resolve(),
              value: { t: (key: string): string => key },
            },
            manifest: { id: "terminal" },
          } as unknown as PluginContext,
          manager = new StorageSettingsManager(
            context,
            LocalSettings.fix,
            storage,
          );
        manager.load();
        try {
          await manager.onLoaded;
          await vi.waitFor(() => {
            expect(setItem).toHaveBeenCalled();
          });
          const text: unknown = setItem.mock.calls[0]?.[1];
          return {
            copies: manager.value.recovery,
            errors: [...errors.mock.calls],
            value: manager.value,
            written: typeof text === "string" ? copy(JSON.parse(text)) : null,
          };
        } finally {
          manager.unload();
          errors.mockRestore();
        }
      }

      it("loads a data.json saved by 3.29.0 without a report and writes every value back", async () => {
        const loaded = await loadSettings(copy(released329));
        expect(loaded.errors).toEqual([]);
        expect(loaded.copies).toEqual({});
        expect(loaded.value).toMatchObject(released329);
        expect(copy(loaded.written)).toMatchObject(released329);
      });

      it("loads a data.json saved by 3.28.0 or an empty one without a report", async () => {
        for (const data of [copy(released328), {}]) {
          const loaded = await loadSettings(data);
          expect(loaded.errors).toEqual([]);
          expect(loaded.copies).toEqual({});
        }
      });

      it("still reports a value it replaces and keeps a copy of what it read", async () => {
        const data = { ...released329, noticeTimeout: "5" },
          loaded = await loadSettings(copy(data));
        expect(loaded.errors).toHaveLength(1);
        expect(loaded.errors[0]?.[0]).toBe("errors.malformed-data");
        expect(Object.keys(loaded.copies)).toEqual([
          expect.stringMatching(/^settings\./u),
        ]);
        expect(
          Object.values(loaded.copies).map((text): unknown => JSON.parse(text)),
        ).toEqual([data]);
        expect(loaded.value.noticeTimeout).toBe(Settings.DEFAULT.noticeTimeout);
      });

      it("loads 3.29.0 local settings without a report and keeps the copy 3.29.0 made", async () => {
        const recovery = {
            "settings.2026-10-14T08:32:47.171Z": JSON.stringify(
              released328,
              null,
              2,
            ),
          },
          loaded = await loadLocalSettings({
            hasUsedIntegratedTerminal: true,
            lastReadChangelogVersion: "3.29.0",
            recovery,
          });
        expect(loaded.errors).toEqual([]);
        expect(loaded.copies).toEqual(recovery);
        expect(loaded.written).toMatchObject({ recovery });

        const cleared = await loadLocalSettings({});
        expect(cleared.errors).toEqual([]);
        expect(cleared.copies).toEqual({});
      });

      it("accepts a profile or a keymapping that lacks a key added later", () => {
        const data = cloneAsWritable(released329),
          profile = data.profiles["custom-integrated"],
          [keymapping] = data.keymappings;
        if (!keymapping) {
          throw new Error("the 3.29.0 fixture has no keymapping");
        }
        Reflect.deleteProperty(profile, "win32Backend");
        Reflect.deleteProperty(profile.terminalOptions, "fontSize");
        Reflect.deleteProperty(keymapping, "platform");
        Reflect.deleteProperty(data.profiles, "developerConsole");
        const developerConsole: Record<string, unknown> = {
          ...released329.profiles.developerConsole,
        };
        Reflect.deleteProperty(developerConsole, "terminalOptions");
        Object.assign(data.profiles, { developerConsole });

        const fixed = Settings.fix(copy(data));
        expect(fixed.valid).toBe(true);
        expect(fixed.value.profiles["custom-integrated"]).toMatchObject({
          win32Backend: "conpty",
        });
        expect(fixed.value.keymappings[0]).toMatchObject({ platform: null });
      });

      it.each([
        [
          "a font size that is not a number",
          {
            terminalOptions: { ...released329.terminalOptions, fontSize: "x" },
          },
        ],
        [
          "a profile option of the wrong type",
          {
            profiles: {
              ...released329.profiles,
              "custom-integrated": {
                ...released329.profiles["custom-integrated"],
                terminalOptions: {
                  ...released329.profiles["custom-integrated"].terminalOptions,
                  cursorBlink: "yes",
                },
              },
            },
          },
        ],
        [
          "a profile key it does not know",
          {
            profiles: {
              ...released329.profiles,
              "custom-external": {
                ...released329.profiles["custom-external"],
                later: true,
              },
            },
          },
        ],
        [
          "a keymapping action it does not know",
          {
            keymappings: [
              { ...released329.keymappings[0], action: "notAnAction" },
              ...released329.keymappings.slice(1),
            ],
          },
        ],
        [
          "a keymapping that is not an object",
          { keymappings: [...released329.keymappings, "x"] },
        ],
        ["a profile list that is a list", { profiles: [] }],
      ])("still reports %s", (_name, change) => {
        expect(Settings.fix(copy({ ...released329, ...change })).valid).toBe(
          false,
        );
      });

      it("adds no profile to the list it read, which the library would not report", () => {
        // The library calls an added key no change, and the profile list is a
        // record: a profile the fixer brought back would pass unreported.
        expect(
          Object.keys(Settings.fix(copy(released329)).value.profiles),
        ).toEqual(Object.keys(released329.profiles));
        expect(
          Settings.fix(copy({ ...released329, profiles: {} })).value.profiles,
        ).toEqual({});
      });

      it("gives the data editor text that it applies unchanged", () => {
        // The data field applies only text that the fixer leaves as it is.
        const data = copy(Settings.fix(copy(released329)).value);
        expect(isEqual(data, Settings.fix(data).value)).toBe(true);
        for (const profile of Object.values(released329.profiles)) {
          const text = copy(profile);
          expect(isEqual(text, Settings.Profile.fix(text).value)).toBe(true);
        }
        const options = copy(released329.terminalOptions);
        expect(
          isEqual(options, Settings.Profile.fixTerminalOptions(options).value),
        ).toBe(true);
      });

      it("loads a profile of an unknown type however deep its data is", async () => {
        // The profile fixer keeps a profile of type "invalid" as it is, so
        // 3.29.0 loaded this data.json without a report.
        const deep: unknown = JSON.parse(
            `${'{"deep":'.repeat(2000)}1${"}".repeat(2000)}`,
          ),
          data = cloneAsWritable(released329);
        Object.assign(data.profiles, { kept: { deep, type: "invalid" } });

        expect(Settings.fix(data).valid).toBe(true);
        const loaded = await loadSettings(data);
        expect(loaded.errors).toEqual([]);
        expect(loaded.value.profiles).toHaveProperty("kept");
      });
    });
  });

  it("Settings.fix validates defaultProfile against available profiles", () => {
    const baseProfiles = {
      foo: Settings.Profile.DEFAULTS.external,
      bar: Settings.Profile.DEFAULTS.integrated,
    };
    const good = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "foo",
    });
    expect(good.value.defaultProfile).toBe("foo");

    const bad = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "doesnotexist",
    });
    expect(bad.value.defaultProfile).toBe(null);

    // null should be preserved and empty-string coerced to null
    const nullVal = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: null,
    });
    expect(nullVal.value.defaultProfile).toBe(null);
    const emptyString = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: "",
    });
    expect(emptyString.value.defaultProfile).toBe(null); // empty string is not treated specially
    // even when the input is wrong type, it should coerce to null
    const alsoBad = Settings.fix({
      profiles: baseProfiles,
      defaultProfile: 123,
    });
    expect(alsoBad.value.defaultProfile).toBe(null);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "Settings.fix drops a default profile that only an inherited property answers (%s)",
    (id) => {
      const fixed = Settings.fix({
        profiles: { foo: Settings.Profile.DEFAULTS.integrated },
        defaultProfile: id,
      });
      expect(fixed.value.defaultProfile).toBeNull();
      expect(fixed.valid).toBe(false);
    },
  );

  it("Settings.fix keeps a default profile stored under the id constructor", () => {
    const stored: unknown = JSON.parse(
        JSON.stringify(
          Settings.fix({
            profiles: { constructor: Settings.Profile.DEFAULTS.integrated },
            defaultProfile: "constructor",
          }).value,
        ),
      ),
      fixed = Settings.fix(stored);
    expect(fixed.value.defaultProfile).toBe("constructor");
    expect(fixed.valid).toBe(true);
  });

  it("Settings.fix preserves valid showTerminalTabPrefix", () => {
    const enabled = Settings.fix({ showTerminalTabPrefix: true });
    expect(enabled.value.showTerminalTabPrefix).toBe(true);

    const disabled = Settings.fix({ showTerminalTabPrefix: false });
    expect(disabled.value.showTerminalTabPrefix).toBe(false);
  });

  it("Settings.fix coerces bad showTerminalTabPrefix to default", () => {
    const bad = Settings.fix({
      showTerminalTabPrefix: "not-a-boolean",
    });
    expect(bad.value.showTerminalTabPrefix).toBe(false);
  });

  describe("Program status", () => {
    // Options of earlier designs of this feature, never released.
    const REMOVED_KEYS = [
        "tabStatusMarks",
        "tabStatusWorkingIndicator",
        "tabStatusPalette",
        "tabStatusTint",
        "tabStatusQuietMarks",
        "tabStatusUnreadBadge",
        "tabStatusReports",
      ],
      // The keys of the builds whose feature was an experiment: the switch
      // was `experiments.tabStatus`, and these were its look.
      EXPERIMENT_KEYS = ["tabIconSet", "tabIconSize", "tabStatusAnimation"],
      /** What `data.json` holds: the settings as written, with `extra` on top. */
      stored = (extra: Readonly<Record<string, unknown>>): unknown =>
        JSON.parse(JSON.stringify({ ...Settings.fix({}).value, ...extra })),
      /** What a build of the experiment wrote, with its switch and look. */
      experimental = (
        on: unknown,
        look: Readonly<Record<string, unknown>> = {},
      ): Readonly<Record<string, unknown>> => {
        const written = cloneAsWritable<Record<string, unknown>>({
          ...Settings.fix({}).value,
          experiments: { tabStatus: on },
          tabIconSet: "bezel",
          tabIconSize: 18,
          tabStatusAnimation: "none",
          ...look,
        });
        delete written["tabStatus"];
        return written;
      };

    it("is Animated until the user chooses another", () => {
      expect(Settings.DEFAULT.tabStatus).toBe("animated");
      expect(Settings.fix({}).value.tabStatus).toBe("animated");
    });

    it("offers None, Still and Animated, in the order the settings tab shows them", () => {
      expect(Settings.TAB_STATUSES).toEqual(["none", "still", "animated"]);
      expect(Settings.DEFAULT.tabStatus).toBe(Settings.TAB_STATUSES[2]);
    });

    it("has no setting of the tab but Program status", () => {
      expect(
        Object.keys(Settings.DEFAULT)
          .filter((key) => /^tab(?:Icon|Status)/u.test(key))
          .sort(),
      ).toEqual(["tabStatus"]);
      for (const key of [...EXPERIMENT_KEYS, ...REMOVED_KEYS]) {
        expect(Settings.DEFAULT).not.toHaveProperty(key);
      }
      for (const name of [
        "TAB_ICON_SETS",
        "TAB_ICON_SIZES",
        "TAB_STATUS_ANIMATIONS",
        "TAB_STATUS_QUIET_MARKS",
      ]) {
        expect(Settings).not.toHaveProperty(name);
      }
    });

    it.each(["none", "still", "animated"] as const)(
      "keeps a stored %s, and is valid with it",
      (tabStatus) => {
        const fixed = Settings.fix(stored({ tabStatus }));
        expect(fixed.value.tabStatus).toBe(tabStatus);
        expect(fixed.valid).toBe(true);
      },
    );

    it("replaces an unknown or mistyped Program status with the default, Animated", () => {
      for (const bad of [
        "loop",
        "on",
        "",
        "Still",
        3,
        true,
        null,
        ["still"],
        { still: true },
      ]) {
        expect(Settings.fix({ tabStatus: bad }).value.tabStatus).toBe(
          "animated",
        );
      }
    });

    describe("from the builds whose feature was an experiment", () => {
      it("turns the switch that was on into Still", () => {
        const fixed = Settings.fix(experimental(true));
        expect(fixed.value.tabStatus).toBe("still");
        // Written back once, without the old keys.
        expect(fixed.valid).toBe(false);
      });

      it("turns the switch that was on, with the dots moving, into Animated", () => {
        expect(
          Settings.fix(experimental(true, { tabStatusAnimation: "loop" })).value
            .tabStatus,
        ).toBe("animated");
      });

      it.each([
        ["none"],
        ["entry"],
        [undefined],
        [null],
        [true],
        ["LOOP"],
      ] as const)(
        "turns the switch that was on into Still under a motion of %j",
        (tabStatusAnimation) => {
          expect(
            Settings.fix(experimental(true, { tabStatusAnimation })).value
              .tabStatus,
          ).toBe("still");
        },
      );

      // Those builds stored the switch only when it was on, so any other
      // value says no more than a switch never touched: the default.
      it.each([[false], ["true"], [1], [null], [{}], [[true]], [undefined]])(
        "gives the default, Animated, for a switch stored as %j, whatever the motion",
        (on) => {
          // Under "none" a switch read as on would give Still instead.
          for (const tabStatusAnimation of ["none", "loop"]) {
            expect(
              Settings.fix(experimental(on, { tabStatusAnimation })).value
                .tabStatus,
            ).toBe("animated");
          }
        },
      );

      it("reads the switch only as the experiment's own stored key", () => {
        // An inherited flag is not a stored flag, as the experiment's fixer read it.
        // A switch read as on would give Still: the motion is "none".
        const inherited: unknown = JSON.parse(
          '{"__proto__":{"tabStatus":true}}',
        );
        expect(
          Settings.fix({ experiments: inherited, tabStatusAnimation: "none" })
            .value.tabStatus,
        ).toBe("animated");
        for (const experiments of [undefined, null, true, "tabStatus", []]) {
          expect(
            Settings.fix({ experiments, tabStatusAnimation: "none" }).value
              .tabStatus,
            JSON.stringify(experiments),
          ).toBe("animated");
        }
      });

      // `JSON.parse` keeps `__proto__` as an own key, as `data.json` can hold
      // it; a copy made by assignment then inherits what it holds. Each
      // inherited value would give another status than the expected one.
      it.each([
        ["Program status", '{"__proto__":{"tabStatus":"still"}}', "animated"],
        [
          "the experiments",
          '{"__proto__":{"experiments":{"tabStatus":true}},"tabStatusAnimation":"none"}',
          "animated",
        ],
        [
          "the motion",
          '{"experiments":{"tabStatus":true},"__proto__":{"tabStatusAnimation":"loop"}}',
          "still",
        ],
        [
          "Program status beside the switch",
          '{"experiments":{"tabStatus":true},"__proto__":{"tabStatus":"none"}}',
          "still",
        ],
      ] as const)(
        "reads %s only as a key stored in the settings themselves, never an inherited one",
        (_what, json, expected) => {
          const read: unknown = JSON.parse(json);
          expect(Settings.fix(read).value.tabStatus).toBe(expected);
        },
      );

      it("lets a stored Program status win over the switch", () => {
        for (const tabStatus of Settings.TAB_STATUSES) {
          expect(
            Settings.fix({
              ...experimental(true, { tabStatusAnimation: "loop" }),
              tabStatus,
            }).value.tabStatus,
          ).toBe(tabStatus);
        }
      });

      it("keeps none of the old keys, and the switch's flag goes with the registry", () => {
        const fixed = Settings.fix(
          experimental(true, {
            tabIconSet: "tile",
            tabIconSize: 22,
            tabStatusAnimation: "loop",
          }),
        ).value;
        for (const key of EXPERIMENT_KEYS) {
          expect(fixed).not.toHaveProperty(key);
        }
        expect(fixed.experiments).toEqual({});
        expect(fixed.tabStatus).toBe("animated");
      });

      it("converges: what is written back keeps the migrated status and is valid", () => {
        for (const [look, expected] of [
          [{ tabStatusAnimation: "loop" }, "animated"],
          [{ tabStatusAnimation: "none" }, "still"],
        ] as const) {
          const first = Settings.fix(experimental(true, look)),
            second = Settings.fix(JSON.parse(JSON.stringify(first.value)));
          expect(first.valid).toBe(false);
          expect(second.valid).toBe(true);
          expect(second.value.tabStatus).toBe(expected);
          expect(second.value).toEqual(first.value);
        }
      });
    });

    it("drops a stored tabStatusReports and reads nothing from it", () => {
      // The switch of the builds before the experiment: never released.
      const fixed = Settings.fix({
        ...JSON.parse(JSON.stringify(Settings.fix({}).value)),
        tabStatus: undefined,
        tabStatusReports: true,
        tabStatusAnimation: "none",
      });
      expect(fixed.valid).toBe(false);
      expect(fixed.value).not.toHaveProperty("tabStatusReports");
      expect(fixed.value.tabStatus).toBe("animated");
      expect(fixed.value.experiments).toEqual({});
    });

    it("drops the options of the earlier designs and leaves the settings beside them as they were", () => {
      const saved = { ...Settings.DEFAULT, tabStatus: "animated" },
        fixed = Settings.fix({
          ...saved,
          tabStatusMarks: "dot",
          tabStatusPalette: "semantic",
          tabStatusQuietMarks: "badge",
          tabStatusTint: "whole",
          tabStatusUnreadBadge: false,
          tabStatusWorkingIndicator: "ring",
        }).value;
      for (const key of REMOVED_KEYS) {
        expect(fixed).not.toHaveProperty(key);
      }
      expect(fixed).toEqual(Settings.fix(saved).value);
      expect(fixed.tabStatus).toBe("animated");
      expect(Settings.fix(JSON.parse(JSON.stringify(fixed))).valid).toBe(true);
    });

    it("adds Animated, the default, to settings saved by 3.28.0", () => {
      // 3.28.0 wrote none of these keys.
      const released: Record<string, unknown> = { ...Settings.DEFAULT };
      delete released["tabStatus"];
      released["showTerminalTabPrefix"] = true;
      const fixed = Settings.fix(released).value;
      expect(fixed.tabStatus).toBe("animated");
      expect(fixed.showTerminalTabPrefix).toBe(true);
      expect(Settings.fix(JSON.parse(JSON.stringify(fixed))).valid).toBe(true);
    });
  });

  describe("Settings.Profile.defaultEntryOfType", () => {
    it("returns [key, profile] tuple for matching profile", () => {
      const profiles: Settings.Profiles = {
        abc123: {
          ...Settings.Profile.DEFAULTS.integrated,
          type: "integrated",
        },
        def456: {
          ...Settings.Profile.DEFAULTS.developerConsole,
          type: "developerConsole",
        },
      };
      const result = Settings.Profile.defaultEntryOfType(
        "integrated",
        profiles,
      );
      expect(result).not.toBeNull();
      const [key, profile] = result ?? ["", {} as Settings.Profile];
      expect(key).toBe("abc123");
      expect(profile.type).toBe("integrated");
    });

    it("returns null when no profile matches", () => {
      const profiles: Settings.Profiles = {};
      expect(
        Settings.Profile.defaultEntryOfType("integrated", profiles),
      ).toBeNull();
    });
  });
});
