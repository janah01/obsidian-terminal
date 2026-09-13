/**
 * Unit tests for `src/terminal/win32-doctor.ts`.
 *
 * Covers:
 * - Windows exit-code translation (9009, 0xC0000142, passthrough)
 * - Python candidate resolution order
 * - Version parsing and the 3.9 minimum
 * - Microsoft Store stub detection
 * - `diagnoseWindowsPython` against a stubbed spawn
 * - `checkWindowsPython` caching, its notice budget, and its silent mode
 * - the plugin-level check: demotion, re-promotion, stale results, and that
 *   no Python value is ever written back
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeepWritable } from "ts-essentials";
import {
  type Win32PythonProcessResult,
  type Win32PythonSpawn,
  applyWin32BackendVerdict,
  checkWindowsResizerPackages,
  classifyPythonResult,
  diagnoseWindowsPython,
  getPluginPythonDiagnosis,
  inheritedPythonExecutable,
  isPythonVersionSupported,
  isStoreStub,
  parsePythonVersion,
  parseWindowsPythonIdentity,
  pythonStatusKey,
  runPluginPythonCheck,
  win32ExitCodeKey,
  win32PythonCandidates,
  win32ResizerInstallCommand,
  checkWindowsPython,
  clearWindowsPythonDiagnoses,
  invalidateWindowsPythonDiagnosis,
} from "../../../src/terminal/win32-doctor.js";
import type { TerminalPlugin } from "../../../src/main.js";
import { Settings } from "../../../src/settings-data.js";

function result(
  overrides: Partial<Win32PythonProcessResult> = {},
): Win32PythonProcessResult {
  return { code: 0, stderr: "", stdout: "", ...overrides };
}

/** Canonical path an installed Microsoft Store Python reports. */
const STORE_PACKAGE_PYTHON =
  "C:\\Program Files\\WindowsApps\\PythonSoftwareFoundation.Python.3.12_3.12.0_x64__qbz5n2kfra8p0\\python.exe";

function identityResult(
  executable = "C:\\Python312\\python.exe",
  version = "3.12.0",
): Win32PythonProcessResult {
  return result({ stdout: `${executable}\r\n${version}\r\n` });
}

describe("src/terminal/win32-doctor.ts", () => {
  describe("win32ExitCodeKey", () => {
    it("translates 9009 to the missing-executable message", () => {
      expect(win32ExitCodeKey(9009)).toBe("errors.win32-exit-9009");
    });

    it("translates 3221225794 (0xC0000142) to the console-init message", () => {
      expect(win32ExitCodeKey(3_221_225_794)).toBe(
        "errors.win32-exit-c0000142",
      );
      expect(win32ExitCodeKey(-1_073_741_502)).toBe(
        "errors.win32-exit-c0000142",
      );
    });

    it("passes every other code and signal through unchanged", () => {
      expect(win32ExitCodeKey(0)).toBeNull();
      expect(win32ExitCodeKey(1)).toBeNull();
      expect(win32ExitCodeKey(9008)).toBeNull();
      expect(win32ExitCodeKey("SIGINT")).toBeNull();
    });
  });

  describe("win32PythonCandidates", () => {
    it("tries the configured executable, then the names, then the launcher", () => {
      expect(win32PythonCandidates("C:\\Python\\python.exe")).toEqual([
        { args: [], executable: "C:\\Python\\python.exe" },
        { args: [], executable: "python" },
        { args: [], executable: "python3" },
        { args: ["-3"], executable: "py" },
      ]);
    });

    it("omits an empty configured executable", () => {
      expect(win32PythonCandidates("")[0]).toEqual({
        args: [],
        executable: "python",
      });
    });
  });

  describe("parsePythonVersion", () => {
    it("reads the version from stdout", () => {
      expect(parsePythonVersion("Python 3.12.1\n")).toBe("3.12.1");
    });

    it("reads a two-component version", () => {
      expect(parsePythonVersion("Python 3.9")).toBe("3.9");
    });

    it("returns an empty string when there is no version", () => {
      expect(parsePythonVersion("")).toBe("");
      expect(parsePythonVersion("bash: python: command not found")).toBe("");
    });
  });

  describe("parseWindowsPythonIdentity", () => {
    it("reads the canonical path and version from the probe", () => {
      expect(
        parseWindowsPythonIdentity(
          "C:\\Program Files\\Python312\\python.exe\r\n3.12.9\r\n",
        ),
      ).toEqual({
        executable: "C:\\Program Files\\Python312\\python.exe",
        version: "3.12.9",
      });
    });

    it("rejects a version-only response without sys.executable", () => {
      expect(parseWindowsPythonIdentity("Python 3.12.9\n")).toBeNull();
    });
  });

  describe("isPythonVersionSupported", () => {
    it("accepts 3.9 and up", () => {
      expect(isPythonVersionSupported("3.9.0")).toBe(true);
      expect(isPythonVersionSupported("3.13.2")).toBe(true);
      expect(isPythonVersionSupported("4.0.0")).toBe(true);
    });

    it("rejects older and unparseable versions", () => {
      expect(isPythonVersionSupported("3.8.10")).toBe(false);
      expect(isPythonVersionSupported("2.7.18")).toBe(false);
      expect(isPythonVersionSupported("")).toBe(false);
      expect(isPythonVersionSupported("three.nine")).toBe(false);
    });
  });

  describe("isStoreStub", () => {
    it("detects a WindowsApps alias that reports no identity", () => {
      // `--version` output carries no sys.executable line, so the identity
      // parse fails and the path heuristic still applies.
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result({ stdout: "Python 3.12.0" }),
        ),
      ).toBe(true);
    });

    it("detects a WindowsApps alias that prints nothing", () => {
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result(),
        ),
      ).toBe(true);
    });

    it("clears a WindowsApps alias that answered the identity probe", () => {
      // An installed Store Python runs through the same alias path.
      expect(
        isStoreStub(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          identityResult(STORE_PACKAGE_PYTHON, "3.12.0"),
        ),
      ).toBe(false);
    });

    it("detects exit code 9009", () => {
      expect(isStoreStub("python", result({ code: 9009 }))).toBe(true);
    });

    it("detects a silent success with no output", () => {
      expect(isStoreStub("python", result({ stdout: "  \n" }))).toBe(true);
    });

    it("leaves a real interpreter alone", () => {
      expect(isStoreStub("python", result({ stdout: "Python 3.12.0\n" }))).toBe(
        false,
      );
    });
  });

  describe("classifyPythonResult", () => {
    it("reports the probed candidate and keeps the canonical path in detail", () => {
      expect(
        classifyPythonResult(
          "python",
          identityResult("C:\\Python311\\python.exe", "3.11.7"),
        ),
      ).toMatchObject({
        candidate: "python",
        detail: "found 3.11.7 at C:\\Python311\\python.exe",
        executable: "python",
        status: "ok",
        version: "3.11.7",
      });
    });

    it("reports too-old below 3.9", () => {
      expect(
        classifyPythonResult("python", identityResult("python", "3.8.10")),
      ).toMatchObject({ status: "too-old", version: "3.8.10" });
    });

    it("marks a timed-out probe transient, not decisively missing", () => {
      expect(
        classifyPythonResult("python", result({ code: null, timedOut: true })),
      ).toMatchObject({ status: "missing", transient: true });
    });

    it("rejects a supported version without canonical identity", () => {
      expect(
        classifyPythonResult(
          "python",
          result({ stderr: "Python 3.12.0\n", stdout: "" }),
        ),
      ).toMatchObject({ status: "missing", version: "3.12.0" });
    });

    it("accepts an installed Store Python behind the WindowsApps alias", () => {
      expect(
        classifyPythonResult(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
          identityResult(STORE_PACKAGE_PYTHON, "3.12.0"),
        ),
      ).toMatchObject({
        executable:
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe",
        status: "ok",
        version: "3.12.0",
      });
    });

    it("keeps store-stub for a WindowsApps alias without identity output", () => {
      expect(
        classifyPythonResult(
          "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
          result({ stdout: "Python 3.12.0" }),
        ),
      ).toMatchObject({ status: "store-stub" });
    });

    it("reports missing when nothing resembles a version", () => {
      expect(
        classifyPythonResult(
          "python",
          result({ code: 1, stderr: "not recognized" }),
        ),
      ).toMatchObject({ status: "missing" });
    });
  });

  describe("diagnoseWindowsPython", () => {
    it("returns the profile executable when it works", async () => {
      const calls: Array<readonly [string, readonly string[]]> = [],
        spawn: Win32PythonSpawn = async (executable, args) => {
          calls.push([executable, args]);
          return identityResult("C:\\Python312\\python.exe");
        };
      await expect(
        diagnoseWindowsPython(spawn, "C:\\Python312\\python.exe"),
      ).resolves.toEqual({
        candidate: "C:\\Python312\\python.exe",
        detail: "found 3.12.0 at C:\\Python312\\python.exe",
        executable: "C:\\Python312\\python.exe",
        status: "ok",
        version: "3.12.0",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("C:\\Python312\\python.exe");
      expect(calls[0]?.[1].slice(0, 1)).toEqual(["-c"]);
    });

    it("falls through the resolution order until one works", async () => {
      const calls: string[] = [],
        spawn: Win32PythonSpawn = async (executable) => {
          calls.push(executable);
          if (executable === "python3") {
            return identityResult("C:\\Python310\\python.exe", "3.10.0");
          }
          return result({ code: 9009 });
        };
      await expect(diagnoseWindowsPython(spawn, "")).resolves.toMatchObject({
        // The canonical path was probed and denied, so the probed name —
        // which launches PID-preserving — stays the spawn target.
        candidate: "python3",
        executable: "python3",
        status: "ok",
      });
      expect(calls).toEqual(["python", "python3", "C:\\Python310\\python.exe"]);
    });

    it("spawns the real interpreter behind an install-manager shim", async () => {
      const canonical =
          "C:\\Users\\a\\AppData\\Local\\Python\\pythoncore-3.14-64\\python.exe",
        spawn: Win32PythonSpawn = async (executable) =>
          executable === "python" || executable === canonical
            ? identityResult(canonical, "3.14.7")
            : result({ code: 9009 });
      await expect(diagnoseWindowsPython(spawn, "")).resolves.toMatchObject({
        /*
         * A shim runs the interpreter as a child process, which breaks the
         * PTY's process identity; the canonical path that answered its own
         * probe is the spawn target. The name stays what the user sees.
         */
        candidate: "python",
        executable: canonical,
        status: "ok",
        version: "3.14.7",
      });
    });

    it("reports the store stub when every candidate is the stub", async () => {
      const spawn: Win32PythonSpawn = async () => result({ code: 9009 });
      await expect(
        diagnoseWindowsPython(spawn, "python"),
      ).resolves.toMatchObject({ executable: "python", status: "store-stub" });
    });

    it("reports the configured executable's failure, not a later one", async () => {
      const spawn: Win32PythonSpawn = async (executable) =>
        executable === "C:\\old\\python.exe"
          ? identityResult("C:\\old\\python.exe", "3.8.0")
          : result({ code: 1, stderr: "not recognized" });
      await expect(
        diagnoseWindowsPython(spawn, "C:\\old\\python.exe"),
      ).resolves.toMatchObject({
        executable: "C:\\old\\python.exe",
        status: "too-old",
        version: "3.8.0",
      });
    });

    it("survives a spawn that throws", async () => {
      const spawn: Win32PythonSpawn = async () => {
        throw new Error("ENOENT");
      };
      await expect(
        diagnoseWindowsPython(spawn, "python"),
      ).resolves.toMatchObject({ executable: "python", status: "missing" });
    });

    it("canonicalizes the py -3 fallback and confirms the canonical path", async () => {
      const canonical = "C:\\Users\\test\\Python312\\python.exe",
        calls: Array<readonly [string, readonly string[]]> = [],
        spawn: Win32PythonSpawn = async (executable, args) => {
          calls.push([executable, args]);
          if (executable === "py" || executable === canonical) {
            return identityResult(canonical, "3.12.9");
          }
          return result({ code: 9009 });
        };

      const diagnosis = await diagnoseWindowsPython(
        spawn,
        "C:\\missing\\python.exe",
      );

      expect(diagnosis).toMatchObject({
        candidate: "py -3",
        executable: canonical,
        status: "ok",
        version: "3.12.9",
      });
      expect(calls.map(([executable]) => executable)).toEqual([
        "C:\\missing\\python.exe",
        "python",
        "python3",
        "py",
        canonical,
      ]);
      expect(calls[3]?.[1].slice(0, 2)).toEqual(["-3", "-c"]);
      // The canonical path was probed on its own before it was returned.
      expect(calls[4]?.[1]).toEqual(["-c", calls[3]?.[1][2] ?? ""]);
    });

    it.each<
      readonly [canonicalFailure: string, probe: () => Win32PythonProcessResult]
    >([
      [
        "is denied",
        (): Win32PythonProcessResult =>
          result({ code: 1, stderr: "Access is denied." }),
      ],
      [
        "never runs",
        (): Win32PythonProcessResult => {
          throw new Error("EACCES");
        },
      ],
    ])(
      "does not run the launcher when its canonical path %s",
      async (_canonicalFailure, probe) => {
        const canonical = "C:\\Users\\test\\Python312\\python.exe",
          calls: string[] = [],
          spawn: Win32PythonSpawn = async (executable) => {
            calls.push(executable);
            if (executable === "py") {
              return identityResult(canonical, "3.12.9");
            }
            if (executable === canonical) {
              return probe();
            }
            return result({ code: 9009 });
          };

        await expect(diagnoseWindowsPython(spawn, "")).resolves.toMatchObject({
          // The launcher's arguments cannot travel to the PTY spawn, so an
          // unconfirmed canonical path disqualifies it and the first failure
          // stands.
          candidate: "python",
          status: "store-stub",
        });
        expect(calls).toEqual(["python", "python3", "py", canonical]);
      },
    );
  });

  describe("inheritedPythonExecutable", () => {
    it("prefers the profile value and falls back to the plugin value", () => {
      expect(inheritedPythonExecutable("", "C:\\Python312\\python.exe")).toBe(
        "C:\\Python312\\python.exe",
      );
      expect(
        inheritedPythonExecutable(
          "C:\\Profile\\python.exe",
          "C:\\Python312\\python.exe",
        ),
      ).toBe("C:\\Profile\\python.exe");
      expect(inheritedPythonExecutable("", "")).toBe("");
    });
  });

  describe("pythonStatusKey", () => {
    const found = classifyPythonResult(
      "C:\\Python312\\python.exe",
      identityResult(),
    );

    it("tells a discovered name apart from a configured path", () => {
      expect(pythonStatusKey({ ...found, candidate: "python" }, false)).toBe(
        "ok-resolved",
      );
      expect(pythonStatusKey(found, false)).toBe("ok");
      expect(
        pythonStatusKey(
          { ...found, candidate: "c:\\python312\\PYTHON.EXE" },
          false,
        ),
      ).toBe("ok");
    });

    it("reports checking before a result and while rechecking", () => {
      expect(pythonStatusKey(null, false)).toBe("checking");
      expect(pythonStatusKey(found, true)).toBe("checking");
    });

    it("passes a failure status through", () => {
      expect(
        pythonStatusKey(
          classifyPythonResult("python", result({ code: 9009 })),
          false,
        ),
      ).toBe("store-stub");
    });
  });
});

describe("checkWindowsPython session cache", () => {
  /** Message keys rendered by the failure notice, newest last. */
  const noticeKeys: string[] = [];

  afterEach(() => {
    clearWindowsPythonDiagnoses();
    noticeKeys.length = 0;
    vi.restoreAllMocks();
  });

  function context(): TerminalPlugin {
    return {
      language: {
        onChangeLanguage: { listen: vi.fn(() => vi.fn()) },
        value: {
          // The notice is the only caller, so each call is one shown notice.
          t: (key: string): string => {
            noticeKeys.push(key);
            return key;
          },
        },
      },
      settings: { value: { errorNoticeTimeout: 0 } },
    } as unknown as TerminalPlugin;
  }

  it("probes once for a usable interpreter", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult());
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
    const probes = spawn.mock.calls.length;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("re-probes after a failure so a mid-session install is picked up", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let installed = false;
    const spawn = vi.fn(async () => {
      if (!installed) throw new Error("ENOENT");
      return identityResult();
    }) as Win32PythonSpawn;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "missing",
    );
    // The notice told the user to install Python; the next open must see it.
    installed = true;
    expect((await checkWindowsPython(context(), "python", spawn)).status).toBe(
      "ok",
    );
  });

  it("shows no notice for a silent check and keeps the budget intact", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(vi.fn()),
      spawn = vi.fn(async () => result({ code: 9009 })) as Win32PythonSpawn,
      ctx = context();

    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("store-stub");
    expect(noticeKeys).toHaveLength(0);
    // The log line stays in both modes.
    expect(warn).toHaveBeenCalledTimes(1);

    // The silent check spent nothing, so the interactive one still notifies.
    expect((await checkWindowsPython(ctx, "python", spawn)).status).toBe(
      "store-stub",
    );
    expect(noticeKeys).toEqual(["errors.win32-python-store-stub"]);

    // And the notice is still shown once per session per configured value.
    await checkWindowsPython(ctx, "python", spawn);
    expect(noticeKeys).toHaveLength(1);
  });

  it("re-probes after a silent failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let installed = false;
    const spawn = vi.fn(async () => {
        if (!installed) throw new Error("ENOENT");
        return identityResult();
      }) as Win32PythonSpawn,
      ctx = context();
    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("missing");
    installed = true;
    expect(
      (await checkWindowsPython(ctx, "python", spawn, { notify: false }))
        .status,
    ).toBe("ok");
    expect(noticeKeys).toHaveLength(0);
  });

  it("re-probes after a runtime failure invalidates a cached success", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      ctx = context();
    await checkWindowsPython(ctx, "python", spawn);
    const probes = spawn.mock.calls.length;
    invalidateWindowsPythonDiagnosis("python");
    await checkWindowsPython(ctx, "python", spawn);
    expect(spawn.mock.calls.length).toBeGreaterThan(probes);
  });

  it("shares one probe between concurrent first callers", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      ctx = context();
    await checkWindowsPython(ctx, "python", spawn);
    const probes = spawn.mock.calls.length;
    clearWindowsPythonDiagnoses();
    spawn.mockClear();
    const [a, b] = await Promise.all([
      checkWindowsPython(ctx, "python", spawn),
      checkWindowsPython(ctx, "python", spawn),
    ]);
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(spawn.mock.calls).toHaveLength(probes);
  });
});

describe("win32ResizerInstallCommand", () => {
  const specs =
    '--upgrade "psutil>=5.9.5,<=7.1.1" "pywinctl>=0.0.50" "typing_extensions>=4.7.1"';

  it("targets the exact interpreter with the manifest's minimums", () => {
    expect(win32ResizerInstallCommand("C:\\Python312\\python.exe")).toBe(
      `C:\\Python312\\python.exe -m pip install ${specs}`,
    );
  });

  it("uses the PowerShell call operator for a path with spaces", () => {
    expect(
      win32ResizerInstallCommand("C:\\Program Files\\Python\\python.exe"),
    ).toBe(`& "C:\\Program Files\\Python\\python.exe" -m pip install ${specs}`);
  });
});

describe("checkWindowsResizerPackages", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
  });

  it("caches a success and skips the probe next time", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => result());
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(spawn.mock.calls).toHaveLength(1);
  });

  it("re-probes after a failure so a pip install is picked up", async () => {
    let installed = false;
    const spawn = vi.fn(async () =>
      installed ? result() : result({ code: 1, stderr: "ModuleNotFoundError" }),
    ) as Win32PythonSpawn;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(false);
    installed = true;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
  });

  it("imports every manifest package in one probe", async () => {
    const seen: (readonly string[])[] = [],
      spawn = (async (_executable, args) => {
        seen.push(args);
        return result();
      }) as Win32PythonSpawn;
    expect(await checkWindowsResizerPackages("py.exe", spawn)).toBe(true);
    expect(seen).toEqual([
      ["-c", "import psutil, pywinctl, typing_extensions"],
    ]);
  });
});

describe("applyWin32BackendVerdict", () => {
  function integratedWin32(
    overrides: Partial<Settings.Profile.Typed<"integrated">> = {},
  ): DeepWritable<Settings.Profile> {
    return {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
      ...overrides,
    } as DeepWritable<Settings.Profile>;
  }

  it("demotes ConPTY profiles and records provenance when Python is missing", () => {
    const profiles = { a: integratedWin32() };
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(true);
    expect(profiles.a).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
  });

  it("re-promotes only auto-demoted profiles, never a user choice", () => {
    const profiles = {
      demoted: integratedWin32({
        win32Backend: "legacy",
        win32BackendAutoDemoted: true,
      }),
      userChoice: integratedWin32({ win32Backend: "legacy" }),
    };
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(true);
    expect(profiles.demoted).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(profiles.userChoice).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: false,
    });
  });

  it("clears a stale marker on a profile that already runs ConPTY", () => {
    const profiles = {
      a: integratedWin32({ win32BackendAutoDemoted: true }),
    };
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(true);
    expect(profiles.a).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
  });

  it("leaves incompatible and non-integrated profiles alone", () => {
    const profiles = {
      external: {
        ...Settings.Profile.DEFAULTS.external,
        platforms: { win32: true },
      },
      unix: integratedWin32({ platforms: { linux: true } }),
    } as unknown as DeepWritable<Settings.Profiles>;
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(false);
    expect(profiles["unix"]).toMatchObject({ win32Backend: "conpty" });
  });

  it("reports an unchanged result as a no-op", () => {
    const profiles = {
      a: integratedWin32({ win32Backend: "legacy" }),
    };
    expect(applyWin32BackendVerdict(profiles, () => false)).toBe(false);
    expect(applyWin32BackendVerdict(profiles, () => true)).toBe(false);
  });
});

describe("runPluginPythonCheck", () => {
  afterEach(() => {
    clearWindowsPythonDiagnoses();
    vi.restoreAllMocks();
  });

  function reconcileContext(initial: {
    readonly defaultProfile?: string | null;
    readonly pythonExecutable?: string;
    readonly profiles?: Record<string, unknown>;
  }): {
    readonly context: TerminalPlugin;
    readonly value: {
      pythonExecutable: string;
      profiles: DeepWritable<Settings.Profiles>;
    };
    readonly write: ReturnType<typeof vi.fn>;
  } {
    const value = {
        defaultProfile: initial.defaultProfile ?? null,
        errorNoticeTimeout: 0,
        profiles: (initial.profiles ?? {}) as DeepWritable<Settings.Profiles>,
        pythonExecutable: initial.pythonExecutable ?? "",
      },
      write = vi.fn(async () => {}),
      context = {
        language: { value: { t: (key: string): string => key } },
        settings: {
          mutate: async (mutator: (settings: typeof value) => unknown) => {
            await mutator(value);
          },
          value,
          write,
        },
      } as unknown as TerminalPlugin;
    return { context, value, write };
  }

  function win32Conpty(
    overrides: Partial<Settings.Profile.Typed<"integrated">> = {},
  ): DeepWritable<Settings.Profile> {
    return {
      ...Settings.Profile.DEFAULTS.integrated,
      platforms: { win32: true },
      ...overrides,
    } as DeepWritable<Settings.Profile>;
  }

  it("leaves an empty plugin-level field empty and publishes the result", async () => {
    const { context: ctx, value, write } = reconcileContext({}),
      spawn = (async (executable) =>
        executable === "python" || executable === "C:\\Python312\\python.exe"
          ? identityResult()
          : result({ code: 9009 })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis).toMatchObject({
      candidate: "python",
      executable: "C:\\Python312\\python.exe",
      status: "ok",
    });
    // The field syncs across devices; the resolution stays in this session.
    expect(value.pythonExecutable).toBe("");
    expect(getPluginPythonDiagnosis(ctx)).toBe(diagnosis);
    expect(write).not.toHaveBeenCalled();
  });

  it("publishes nothing from a check a newer one overtook", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const oldPath = "C:\\Old\\python.exe",
      newPath = "D:\\New\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: { inherited: win32Conpty() },
        pythonExecutable: oldPath,
      }),
      finishOld: ((probe: Win32PythonProcessResult) => void)[] = [],
      oldProbe = new Promise<Win32PythonProcessResult>((resolve) => {
        finishOld.push(resolve);
      }),
      spawn = (async (executable) => {
        if (executable === oldPath) return oldProbe;
        if (executable === newPath) return identityResult(newPath);
        return result({ code: 9009 });
      }) as Win32PythonSpawn;
    const oldCheck = runPluginPythonCheck(ctx, spawn);
    // The user types another interpreter and rechecks while the first probe
    // is still waiting.
    value.pythonExecutable = newPath;
    const newer = await runPluginPythonCheck(ctx, spawn);
    expect(newer.status).toBe("ok");
    finishOld[0]?.(result({ code: 9009 }));
    expect((await oldCheck).status).not.toBe("ok");
    // The old failure neither replaces the status nor demotes anything.
    expect(getPluginPythonDiagnosis(ctx)).toBe(newer);
    expect(value.profiles["inherited"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("re-probes a profile override that stopped working", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const venv = "C:\\venv\\Scripts\\python.exe";
    let installed = true;
    const { context: ctx, value } = reconcileContext({
        profiles: { custom: win32Conpty({ pythonExecutable: venv }) },
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
        executable === venv && installed
          ? identityResult(venv)
          : result({ code: 9009 }),
      );
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["custom"]).toMatchObject({ win32Backend: "conpty" });
    // The opener's cache holds the override's success from the first check.
    const probes = spawn.mock.calls.length;
    await checkWindowsPython(ctx, venv, spawn, { notify: false });
    expect(spawn.mock.calls).toHaveLength(probes);

    installed = false;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["custom"]).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
    // ...and the next open re-probes instead of reusing it.
    const probes2 = spawn.mock.calls.length;
    await checkWindowsPython(ctx, venv, spawn, { notify: false });
    expect(spawn.mock.calls.length).toBeGreaterThan(probes2);
  });

  it("keeps a user-set field even when discovery finds another Python", async () => {
    vi.spyOn(console, "debug").mockImplementation(vi.fn());
    const { context: ctx, value } = reconcileContext({
        pythonExecutable: "C:\\user\\python.exe",
      }),
      spawn = (async (executable) =>
        executable === "python"
          ? identityResult()
          : result({ code: 9009 })) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(value.pythonExecutable).toBe("C:\\user\\python.exe");
  });

  it("demotes on a missing result, then re-promotes after an install", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    let installed = false;
    const { context: ctx, value } = reconcileContext({
        profiles: {
          auto: win32Conpty(),
          userChoice: win32Conpty({ win32Backend: "legacy" }),
        },
      }),
      spawn = (async () => {
        if (!installed) return result({ code: 9009 });
        return identityResult();
      }) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).not.toBe("ok");
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "legacy",
      win32BackendAutoDemoted: true,
    });
    // The user asked for ConHost; that is not a demotion.
    expect(value.profiles["userChoice"]).toMatchObject({
      win32BackendAutoDemoted: false,
    });
    installed = true;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(value.profiles["userChoice"]).toMatchObject({
      win32Backend: "legacy",
    });
  });

  it("leaves stored backends alone on a transient probe failure", async () => {
    // One timed-out candidate might have been the working interpreter, so
    // "missing" is not decisive: nothing is demoted and nothing is written.
    const {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: { auto: win32Conpty() },
      }),
      spawn = (async (executable) =>
        executable === "python3"
          ? result({ code: null, timedOut: true })
          : result({ code: 9009 })) as Win32PythonSpawn;
    const diagnosis = await runPluginPythonCheck(ctx, spawn);
    expect(diagnosis.status).not.toBe("ok");
    expect(diagnosis.transient).toBe(true);
    expect(value.profiles["auto"]).toMatchObject({
      win32Backend: "conpty",
      win32BackendAutoDemoted: false,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses each profile's Python when global discovery fails (timeout: %s)",
    async (timedOut) => {
      vi.spyOn(console, "warn").mockImplementation(vi.fn());
      const python = "C:\\portable\\python.exe",
        { context: ctx, value } = reconcileContext({
          profiles: {
            inherited: win32Conpty(),
            working: win32Conpty({ pythonExecutable: python }),
            demoted: win32Conpty({
              pythonExecutable: "portable-shim",
              win32Backend: "legacy",
              win32BackendAutoDemoted: true,
            }),
            manual: win32Conpty({
              pythonExecutable: python,
              win32Backend: "legacy",
            }),
            slow: win32Conpty({ pythonExecutable: "slow-python" }),
          },
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) => {
          if (executable === python || executable === "portable-shim")
            return identityResult(python);
          return result({
            code: 9009,
            timedOut: timedOut || executable === "slow-python",
          });
        });

      await runPluginPythonCheck(ctx, spawn);

      expect(value.profiles["working"]).toMatchObject({
        pythonExecutable: python,
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["demoted"]).toMatchObject({
        // Re-promoted by its own value, which stays the portable name.
        pythonExecutable: "portable-shim",
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["manual"]).toMatchObject({
        win32Backend: "legacy",
        win32BackendAutoDemoted: false,
      });
      expect(value.profiles["inherited"]).toMatchObject({
        win32Backend: timedOut ? "conpty" : "legacy",
        win32BackendAutoDemoted: !timedOut,
      });
      expect(value.profiles["slow"]).toMatchObject({
        win32Backend: "conpty",
        win32BackendAutoDemoted: false,
      });
    },
  );

  it.each([false, true])(
    "uses the failed override's fallback chain (available: %s)",
    async (fallbackAvailable) => {
      const python = "C:\\plugin\\python.exe",
        { context: ctx, value } = reconcileContext({
          pythonExecutable: python,
          profiles: {
            custom: win32Conpty({ pythonExecutable: "missing-python" }),
          },
        }),
        spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
          executable === python ||
          (fallbackAvailable && executable === "python")
            ? identityResult(python)
            : result({ code: 9009 }),
        );

      expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
      expect(value.profiles["custom"]).toMatchObject({
        pythonExecutable: "missing-python",
        win32Backend: fallbackAvailable ? "conpty" : "legacy",
        win32BackendAutoDemoted: !fallbackAvailable,
      });
      expect(
        spawn.mock.calls.filter(
          ([executable]) => executable === "missing-python",
        ),
      ).toHaveLength(1);
    },
  );

  it("skips the settings write when the result changed nothing", async () => {
    const { context: ctx, write } = reconcileContext({
        profiles: { auto: win32Conpty() },
        pythonExecutable: "python",
      }),
      spawn = (async () => identityResult()) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a profile's shim value and caches the interpreter it runs", async () => {
    const canonical = "C:\\Python\\pythoncore-3.14-64\\python.exe",
      {
        context: ctx,
        value,
        write,
      } = reconcileContext({
        profiles: {
          shimmed: win32Conpty({ pythonExecutable: "python" }),
        },
      }),
      spawn = vi.fn<Win32PythonSpawn>(async (executable) =>
        executable === "python" || executable === canonical
          ? identityResult(canonical, "3.14.7")
          : result({ code: 9009 }),
      );
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    // The stored value syncs and stays portable; the opener reaches the
    // interpreter through the session cache without another probe.
    expect(value.profiles["shimmed"]).toMatchObject({
      pythonExecutable: "python",
    });
    expect(value.pythonExecutable).toBe("");
    expect(write).not.toHaveBeenCalled();
    const probes = spawn.mock.calls.length;
    expect((await checkWindowsPython(ctx, "python", spawn)).executable).toBe(
      canonical,
    );
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("keeps a profile Python value when nothing resolves", async () => {
    const { context: ctx, value } = reconcileContext({
        profiles: {
          broken: win32Conpty({
            pythonExecutable: "C:\\gone\\python.exe",
          }),
        },
      }),
      spawn = (async () => result({ code: 9009 })) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).not.toBe("ok");
    expect(value.profiles["broken"]).toMatchObject({
      pythonExecutable: "C:\\gone\\python.exe",
    });
  });

  it("keeps a profile override that fails while the chain finds another Python", async () => {
    // The fallback chain's pick is not a resolution of the user's value.
    const venv = "C:\\venv\\Scripts\\python.exe",
      { context: ctx, value } = reconcileContext({
        profiles: {
          dead: win32Conpty({ pythonExecutable: venv }),
          slow: win32Conpty({ pythonExecutable: "C:\\slow\\python.exe" }),
        },
      }),
      spawn = (async (executable) => {
        if (executable === "py" || executable === "C:\\Python312\\python.exe")
          return identityResult();
        if (executable === "C:\\slow\\python.exe")
          return result({ code: null, timedOut: true });
        return result({ code: 9009 });
      }) as Win32PythonSpawn;
    expect((await runPluginPythonCheck(ctx, spawn)).status).toBe("ok");
    expect(value.profiles["dead"]).toMatchObject({ pythonExecutable: venv });
    expect(value.profiles["slow"]).toMatchObject({
      pythonExecutable: "C:\\slow\\python.exe",
    });
  });

  it("never rewrites a profile's Python value", async () => {
    // A value shared by a Windows profile and a macOS one syncs to both; a
    // Windows path written into it would break the other platform.
    const canonical = "C:\\Python\\pythoncore-3.14-64\\python.exe",
      { context: ctx, value } = reconcileContext({
        profiles: {
          mac: win32Conpty({
            platforms: { darwin: true },
            pythonExecutable: "python",
          }),
          win: win32Conpty({ pythonExecutable: "python" }),
        },
      }),
      spawn = (async (executable) =>
        executable === "python" || executable === canonical
          ? identityResult(canonical, "3.14.7")
          : result({ code: 9009 })) as Win32PythonSpawn;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.profiles["win"]).toMatchObject({ pythonExecutable: "python" });
    expect(value.profiles["mac"]).toMatchObject({ pythonExecutable: "python" });
  });

  it("keeps a user-typed value that no longer runs", async () => {
    vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const { context: ctx, value } = reconcileContext({
        pythonExecutable: "C:\\user\\python.exe",
      }),
      spawn = (async () => result({ code: 9009 })) as Win32PythonSpawn;
    await runPluginPythonCheck(ctx, spawn);
    expect(value.pythonExecutable).toBe("C:\\user\\python.exe");
  });

  it("seeds the session cache under the configured value", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      { context: ctx, value } = reconcileContext({});
    await runPluginPythonCheck(ctx, spawn);
    const probes = spawn.mock.calls.length;
    // The opener keys its check by the configured value — empty here — so
    // the first open after discovery must not boot the interpreter again.
    expect(value.pythonExecutable).toBe("");
    await checkWindowsPython(ctx, value.pythonExecutable, spawn);
    expect(spawn.mock.calls).toHaveLength(probes);
  });

  it("probes fresh on every plugin-level check", async () => {
    const spawn = vi.fn<Win32PythonSpawn>(async () => identityResult()),
      { context: ctx } = reconcileContext({
        pythonExecutable: "python",
      });
    await runPluginPythonCheck(ctx, spawn);
    // A cached success would hide an uninstall.
    const probes = spawn.mock.calls.length;
    await runPluginPythonCheck(ctx, spawn);
    expect(spawn.mock.calls.length).toBeGreaterThan(probes);
  });
});
