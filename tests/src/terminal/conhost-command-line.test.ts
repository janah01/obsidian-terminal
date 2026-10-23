/**
 * Windows probe: what reaches a program that the ConHost batch file starts.
 *
 * Runs real `cmd.exe` and `conhost.exe` on batch files that take the command
 * line from the environment, with delayed expansion or with percent expansion
 * and the variables cleared before the program starts, and checks what the
 * program receives against the command line the ConPTY host builds
 * (`quote_argument` in `win32_conpty.py`).
 */
import { execFile, spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { WindowsPseudoterminal } from "../../../src/terminal/pseudoterminal.js";

const WINDOWS = process.platform === "win32",
  RUN_TIMEOUT_MS = 20_000,
  TEST_TIMEOUT_MS = 60_000,
  CMD = "C:\\Windows\\System32\\cmd.exe",
  POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  HOSTNAME = "C:\\Windows\\System32\\HOSTNAME.EXE",
  PROBE_PY = [
    "import ctypes, json, os, sys",
    "kernel32 = ctypes.windll.kernel32",
    "kernel32.GetCommandLineW.restype = ctypes.c_wchar_p",
    "with open(os.environ['PROBE_OUT'], 'w', encoding='utf-8') as out:",
    "    json.dump({",
    "        'argv': sys.argv[1:],",
    "        'line': kernel32.GetCommandLineW(),",
    "        'q': os.environ.get('q'),",
    "        'leaked': sorted(n for n in os.environ if n.upper().startswith('PROBE_') and n.upper() not in ('PROBE_OUT', 'PROBE_CODE')),",
    "    }, out)",
    "sys.exit(int(os.environ.get('PROBE_CODE', '0')))",
    "",
  ].join("\r\n");

/** The shipped escaping, reached through a subclass. */
class Shipped extends WindowsPseudoterminal {
  public static escape(arg: string): string {
    return super.escapeArgumentForBat(arg);
  }
}

/** `quote_argument` of `win32_conpty.py`, ported. */
function quoteArgument(argument: string): string {
  if (argument && !/[ \t\n\v"]/u.test(argument)) return argument;
  let out = '"',
    backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      ++backslashes;
      continue;
    }
    out +=
      character === '"'
        ? `${"\\".repeat(backslashes * 2 + 1)}"`
        : `${"\\".repeat(backslashes)}${character}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

function refuseLineBreaks(text: string): void {
  if (["\r", "\n", "\0", "\u001a"].some((bad) => text.includes(bad)))
    throw new Error("a batch line cannot carry CR, LF, NUL or Ctrl+Z");
}

/** Text that percent expansion inserts with delayed expansion off. */
function caretEscaped(text: string): string {
  refuseLineBreaks(text);
  return text.replace(/[\^&|<>()"]/gu, "^$&");
}

interface Run {
  readonly exe: string;
  readonly args: readonly string[];
  readonly exitFile: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

type Design = (run: Run) => {
  readonly batch: string;
  readonly env: Readonly<Record<string, string>>;
};

const HEADER = "@echo off\r\nsetlocal EnableDelayedExpansion\r\n",
  DESIGNS: Readonly<Record<string, Design>> = {
    shipped: ({ args, exe, exitFile }) => ({
      batch: `${HEADER}set q=\\"\r\n${[exe, ...args]
        .map((arg) => Shipped.escape(arg))
        .join(" ")} & echo !ERRORLEVEL! > ${Shipped.escape(exitFile)}`,
      env: {},
    }),
    environment: ({ args, exe, exitFile }) => ({
      batch: `${HEADER}"!PROBE_EXE!"${
        args.length ? " !PROBE_ARGS!" : ""
      }& echo !ERRORLEVEL! > "!PROBE_EXIT!"`,
      env: {
        PROBE_ARGS: args.map(quoteArgument).join(" "),
        PROBE_EXE: exe,
        PROBE_EXIT: exitFile,
      },
    }),
    environmentCleared: ({ args, exe, exitFile }) => ({
      batch: `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "PROBE_ARGS=" & set "PROBE_EXE=" & set "PROBE_EXIT=" & "%PROBE_EXE%"${
        args.length ? " %PROBE_ARGS%" : ""
      }& >"%PROBE_EXIT%" call echo %%ERRORLEVEL%%`,
      env: {
        PROBE_ARGS: caretEscaped(args.map(quoteArgument).join(" ")),
        PROBE_EXE: exe,
        PROBE_EXIT: exitFile,
      },
    }),
  },
  DESIGN_NAMES = Object.keys(DESIGNS);

interface Outcome {
  readonly refused?: string;
  readonly cmdExit?: number | null;
  readonly exit?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly probe?: {
    readonly argv: readonly string[];
    readonly line: string;
    readonly q: string | null;
    readonly leaked: readonly string[];
  } | null;
  readonly batch?: string;
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function runBatch(
  design: string,
  run: Run,
  host: "cmd" | "conhost" = "cmd",
): Promise<Outcome> {
  let built;
  try {
    built = DESIGNS[design]?.(run);
  } catch (error) {
    return { refused: String(error) };
  }
  if (!built) throw new Error(design);
  const dir = await mkdtemp(join(tmpdir(), "probe-")),
    batchPath = join(dir, "run.bat"),
    probeOut = join(dir, "probe.json");
  await writeFile(batchPath, built.batch, "utf-8");
  const child = spawn(
      host === "cmd" ? CMD : "C:\\Windows\\System32\\conhost.exe",
      host === "cmd" ? ["/d", "/c", batchPath] : [batchPath],
      {
        env: { ...process.env, PROBE_OUT: probeOut, ...run.env, ...built.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    ),
    stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (host === "cmd") child.stdin.end(run.stdin ?? "");
  const cmdExit = await new Promise<number | null>((resolve) => {
    const timer = window.setTimeout(() => {
      child.kill();
      resolve(null);
    }, RUN_TIMEOUT_MS);
    child.once("exit", (code) => {
      window.clearTimeout(timer);
      resolve(code);
    });
  });
  const probeText = await readOrNull(probeOut);
  return {
    batch: built.batch,
    cmdExit,
    exit: (await readOrNull(run.exitFile))?.trim() ?? null,
    probe:
      probeText === null ? null : (JSON.parse(probeText) as Outcome["probe"]),
    stderr: Buffer.concat(stderr).toString("latin1"),
    stdout: Buffer.concat(stdout).toString("latin1"),
  };
}

function report(label: string, outcome: unknown): void {
  console.log(`PROBE ${JSON.stringify({ label, outcome })}`);
}

const CTRL_C_PY = [
  "import ctypes, signal, sys, time",
  "signal.signal(signal.SIGINT, lambda *_: None)",
  "ctypes.windll.kernel32.GenerateConsoleCtrlEvent(0, 0)",
  "time.sleep(1)",
  "sys.exit(7)",
  "",
].join("\r\n");

let python = "",
  probePy = "",
  work = "";

async function freshExitFile(
  name = "exit.txt",
  parent?: string,
): Promise<string> {
  const dir = await mkdtemp(join(parent ?? work, "x-"));
  return join(dir, name);
}

describe.runIf(WINDOWS)("ConHost batch command line on real cmd.exe", () => {
  beforeAll(async () => {
    const { stdout } = await promisify(execFile)("python", [
      "-c",
      "import sys; print(getattr(sys, '_base_executable', sys.executable))",
    ]);
    python = stdout.trim();
    work = await mkdtemp(join(tmpdir(), "conhost-probe-"));
    probePy = join(work, "probe.py");
    await writeFile(probePy, PROBE_PY, "utf-8");
    await writeFile(join(work, "ctrl_c.py"), CTRL_C_PY, "utf-8");
    await writeFile(join(work, "nine.cmd"), "@exit /b 9\r\n", "utf-8");
    report("setup", { python, work });
  }, TEST_TIMEOUT_MS);

  const PYTHON_CASES: readonly (readonly [string, readonly string[]])[] = [
    ["plain", ["plain"]],
    ["space", ["two words"]],
    ["switches", ["/d", "/k", "-c"]],
    ["caret", ["a^b"]],
    ["caret and bang", ["a^b!"]],
    ["percent", ["100%", "%PATH%", "%%", "%~dp0"]],
    ["cmd specials", ["a&b|c<d>e(f)g"]],
    ["specials with spaces", ["a & b | c > d"]],
    ["quotes", ['say "hi"']],
    ["trailing backslash", ["C:\\dir\\", "next"]],
    ["trailing backslash with space", ["C:\\Program Files\\", "next"]],
    ["backslash before quote", ['a\\"b', 'c\\\\"d']],
    ["empty", ["", "x"]],
    ["bang", ["wow!", "!PATH!"]],
    ["expansion lookalikes", ["!q!", "!ERRORLEVEL!", "%q%"]],
    ["unbalanced quote", ['"', "x"]],
    ["quotes around specials", ['a"&"b', "c^d"]],
    ["caret at end", ["end^"]],
    ["double space", ["a  b"]],
    ["tab", ["a\tb"]],
    ["delimiters", ["a=b,c;d"]],
    ["apostrophe and backquote", ["it's `x`"]],
    ["non-ASCII", ["J\u00fcrgen", "\u65e5\u672c\u8a9e", "\u{1f600}"]],
    ["mixed", ["C:\\Program Files\\x y\\", "-c", 'print("a & b")', "100% ^!"]],
    ["line feed", ["line1\nline2"]],
  ];

  describe.each(DESIGN_NAMES)("%s", (design) => {
    it.each([8_000, 8_100, 8_150, 8_170, 8_180, 8_191, 8_200, 9_000])(
      "passes an argument of %i characters",
      async (length) => {
        const args = ["x".repeat(length)],
          outcome = await runBatch(design, {
            args: [probePy, ...args],
            env: { PROBE_CODE: "0" },
            exe: python,
            exitFile: await freshExitFile(),
          });
        report(`${design} long ${String(length)}`, {
          argvLength: outcome.probe?.argv[0]?.length ?? null,
          cmdExit: outcome.cmdExit,
          exit: outcome.exit,
          refused: outcome.refused,
          stderr: outcome.stderr,
          stdout: outcome.stdout,
          batchLength: outcome.batch?.length ?? null,
        });
        expect(outcome.probe?.argv).toEqual(args);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "reports the exit code of a .cmd program",
      async () => {
        const outcome = await runBatch(design, {
          args: [],
          env: {},
          exe: join(work, "nine.cmd"),
          exitFile: await freshExitFile(),
        });
        report(`${design} cmd-file exit`, outcome);
        expect(outcome.exit).toBe("9");
      },
      TEST_TIMEOUT_MS,
    );
    it.skip.each(PYTHON_CASES)(
      "python receives %s",
      async (label, args) => {
        const exitFile = await freshExitFile(),
          outcome = await runBatch(design, {
            args: [probePy, ...args],
            env: { PROBE_CODE: "0" },
            exe: python,
            exitFile,
          });
        report(`${design} python ${label}`, outcome);
        if (outcome.refused !== undefined) {
          expect.soft(outcome.refused).toBe("not refused");
          return;
        }
        expect.soft(outcome.probe?.argv).toEqual(args);
        expect
          .soft(outcome.probe?.line)
          .toBe(
            `"${python}" ${[probePy, ...args].map(quoteArgument).join(" ")}`,
          );
        expect.soft(outcome.exit).toBe("0");
      },
      TEST_TIMEOUT_MS,
    );

    it.skip.each<readonly [string, readonly string[], string]>([
      ["prompt", ["/d", "/c", "prompt CMD$G$S"], "0"],
      ["exit in quotes", ["/d", "/c", "exit 3"], "3"],
      ["chained", ["/d", "/c", "echo a & exit 4"], "4"],
      ["split", ["/d", "/c", "exit", "5"], "5"],
      ["percent", ["/d", "/c", "if %OS%==Windows_NT exit 6"], "6"],
    ])(
      "cmd runs %s",
      async (label, args, expected) => {
        const outcome = await runBatch(design, {
          args,
          env: {},
          exe: CMD,
          exitFile: await freshExitFile(),
        });
        report(`${design} cmd ${label}`, outcome);
        expect(outcome.exit).toBe(expected);
      },
      TEST_TIMEOUT_MS,
    );

    it.skip(
      "cmd /k keeps the profile prompt",
      async () => {
        const outcome = await runBatch(design, {
          args: ["/d", "/k", "prompt CMD$G$S"],
          env: {},
          exe: CMD,
          exitFile: await freshExitFile(),
          stdin: "echo [%PROMPT%]\r\nexit 0\r\n",
        });
        report(`${design} cmd /k prompt`, outcome);
        expect.soft(outcome.stderr).toBe("");
        expect.soft(outcome.stdout).toContain("[CMD$G$S]");
      },
      TEST_TIMEOUT_MS,
    );

    it.skip.each<readonly [string, string, readonly string[], string]>([
      ["exit", POWERSHELL, ["-Command", "exit 7"], "7"],
      [
        "single quotes",
        POWERSHELL,
        ["-Command", "if ('a b' -eq 'a b') { exit 8 }"],
        "8",
      ],
      [
        "double quotes",
        POWERSHELL,
        ["-Command", 'exit ("abc".Length + 6)'],
        "9",
      ],
      ["caret", POWERSHELL, ["-Command", "exit ('a^b'.Length)"], "3"],
      ["ampersand", POWERSHELL, ["-Command", "exit ('a & b'.Length)"], "5"],
      ["pwsh in Program Files", PWSH, ["-Command", "exit 10"], "10"],
    ])(
      "PowerShell runs %s",
      async (label, exe, args, expected) => {
        if (exe === PWSH) {
          try {
            await access(PWSH);
          } catch {
            report(`${design} powershell ${label}`, "pwsh missing");
            return;
          }
        }
        const outcome = await runBatch(design, {
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", ...args],
          env: {},
          exe,
          exitFile: await freshExitFile(),
        });
        report(`${design} powershell ${label}`, outcome);
        expect(outcome.exit).toBe(expected);
      },
      TEST_TIMEOUT_MS,
    );

    it.skip.each([
      "plain",
      "a^b",
      "a b & c",
      "100% x",
      "wow!",
      "J\u00fcrgen",
      "(x) y",
    ])(
      "starts a program in folder %s",
      async (folder) => {
        const dir = join(work, `exe-${design}`, folder);
        await mkdir(dir, { recursive: true });
        const exe = join(dir, "HOSTNAME.EXE");
        await copyFile(HOSTNAME, exe);
        const outcome = await runBatch(design, {
          args: [],
          env: {},
          exe,
          exitFile: await freshExitFile(),
        });
        report(`${design} exe folder ${folder}`, outcome);
        expect(outcome.exit).toBe("0");
      },
      TEST_TIMEOUT_MS,
    );

    it.skip.each(["e^x", "e!x", "e&x y", "e%x", "J\u00fcrgen"])(
      "writes the exit code into folder %s",
      async (folder) => {
        const parent = join(work, `exit-${design}`, folder);
        await mkdir(parent, { recursive: true });
        const exitFile = await freshExitFile("exit.txt", parent),
          outcome = await runBatch(design, {
            args: [probePy],
            env: { PROBE_CODE: "12" },
            exe: python,
            exitFile,
          });
        report(`${design} exit folder ${folder}`, outcome);
        expect(outcome.exit).toBe("12");
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe.each(DESIGN_NAMES)("%s through conhost.exe", (design) => {
    it(
      "keeps the exit code after Ctrl+C in the console",
      async () => {
        const outcome = await runBatch(
          design,
          {
            args: [join(work, "ctrl_c.py")],
            env: {},
            exe: python,
            exitFile: await freshExitFile(),
          },
          "conhost",
        );
        report(`${design}Conhost ctrl-c`, {
          ...outcome,
          terminatePrompt: /Terminate batch job/iu.test(outcome.stdout ?? ""),
        });
        expect.soft(outcome.cmdExit).not.toBeNull();
        expect.soft(outcome.exit).toBe("7");
        expect.soft(outcome.stdout ?? "").not.toMatch(/Terminate batch job/iu);
      },
      TEST_TIMEOUT_MS,
    );
    it.skip.each<readonly [string, readonly string[], string]>([
      ["prompt", ["/d", "/c", "prompt CMD$G$S"], "0"],
      ["exit in quotes", ["/d", "/c", "exit 3"], "3"],
      ["chained", ["/d", "/c", "echo a & exit 4"], "4"],
      ["split", ["/d", "/c", "exit", "5"], "5"],
    ])(
      "cmd runs %s",
      async (label, args, expected) => {
        const outcome = await runBatch(
          design,
          { args, env: {}, exe: CMD, exitFile: await freshExitFile() },
          "conhost",
        );
        report(`${design}Conhost cmd ${label}`, outcome);
        expect(outcome.exit).toBe(expected);
      },
      TEST_TIMEOUT_MS,
    );

    it.skip.each(
      PYTHON_CASES.filter(([label]) =>
        [
          "plain",
          "switches",
          "caret",
          "trailing backslash",
          "non-ASCII",
          "mixed",
          "line feed",
        ].includes(label),
      ),
    )(
      "python receives %s",
      async (label, args) => {
        const outcome = await runBatch(
          design,
          {
            args: [probePy, ...args],
            env: { PROBE_CODE: "0" },
            exe: python,
            exitFile: await freshExitFile(),
          },
          "conhost",
        );
        report(`${design}Conhost python ${label}`, outcome);
        if (outcome.refused !== undefined) return;
        expect.soft(outcome.probe?.argv).toEqual(args);
        expect.soft(outcome.exit).toBe("0");
      },
      TEST_TIMEOUT_MS,
    );
  });
});
