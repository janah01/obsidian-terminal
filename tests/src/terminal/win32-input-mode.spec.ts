import { describe, expect, it } from "vitest";
import {
  Win32ControlKeyState,
  Win32InputMode,
} from "../../../src/terminal/win32-input-mode.js";

/** `keyCode` is a getter on the real event, so it is defined explicitly. */
function keyboardEvent(
  overrides: Readonly<Partial<KeyboardEvent>>,
  keyCode?: number,
): KeyboardEvent {
  const event = new KeyboardEvent(overrides.type ?? "keydown", overrides);
  if (keyCode !== void 0) {
    Object.defineProperty(event, "keyCode", { value: keyCode });
  }
  return event;
}

describe("Win32InputMode", () => {
  const mode = new Win32InputMode();

  it("encodes keydown and keyup with the six Win32 fields", () => {
    const event = keyboardEvent({ code: "KeyA", key: "a" });

    expect(mode.encode(event, true)).toBe("\x1b[65;30;97;1;0;1_");
    expect(mode.encode(event, false)).toBe("\x1b[65;30;97;0;0;1_");
  });

  it("encodes Backspace as VK 8, scan code 14, and Unicode 8", () => {
    const event = keyboardEvent({ code: "Backspace", key: "Backspace" });

    expect(mode.encode(event, true)).toBe("\x1b[8;14;8;1;0;1_");
  });

  it("encodes Ctrl+Backspace with Unicode DEL and left Ctrl state", () => {
    const event = keyboardEvent({
      code: "Backspace",
      ctrlKey: true,
      key: "Backspace",
    });

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [8, 14, 127, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it("encodes Enter, Tab, and Escape with their control characters", () => {
    expect(
      mode.encode(keyboardEvent({ code: "Enter", key: "Enter" }), true),
    ).toBe("\x1b[13;28;13;1;0;1_");
    expect(mode.encode(keyboardEvent({ code: "Tab", key: "Tab" }), true)).toBe(
      "\x1b[9;15;9;1;0;1_",
    );
    expect(
      mode.encode(keyboardEvent({ code: "Escape", key: "Escape" }), true),
    ).toBe("\x1b[27;1;27;1;0;1_");
  });

  it("maps Ctrl+letter to its ASCII control character", () => {
    const event = keyboardEvent({ code: "KeyC", ctrlKey: true, key: "c" });

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [67, 46, 3, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it("marks navigation and right-side modifier keys as enhanced", () => {
    const arrow = keyboardEvent({ code: "ArrowLeft", key: "ArrowLeft" });
    const rightControl = keyboardEvent({
      code: "ControlRight",
      ctrlKey: true,
      key: "Control",
    });

    expect(mode.encode(arrow, true)).toBe(
      "\x1b[" +
        [37, 75, 0, 1, Win32ControlKeyState.ENHANCED_KEY, 1].join(";") +
        "_",
    );
    expect(mode.encode(rightControl, true)).toBe(
      "\x1b[" +
        [
          17,
          29,
          0,
          1,
          Win32ControlKeyState.RIGHT_CTRL_PRESSED |
            Win32ControlKeyState.ENHANCED_KEY,
          1,
        ].join(";") +
        "_",
    );
  });

  it("encodes an unmapped key by its keyCode alone", () => {
    const event = keyboardEvent({ key: "Unidentified" }, 255);

    expect(mode.encode(event, true)).toBe("\x1b[255;0;0;1;0;1_");
  });

  // The virtual key follows the layout (`keyCode`); the scan code follows the
  // physical position (`code`). On a non-US layout the two disagree, exactly
  // as Windows reports them.

  it("takes the virtual key from keyCode, so QWERTZ Ctrl+Z is VK_Z", () => {
    const event = keyboardEvent({ code: "KeyY", ctrlKey: true, key: "z" }, 90);

    expect(mode.encode(event, true)).toBe(
      "\x1b[" +
        [90, 21, 26, 1, Win32ControlKeyState.LEFT_CTRL_PRESSED, 1].join(";") +
        "_",
    );
  });

  it("encodes numpad End without NumLock as VK_END on the numpad scan code", () => {
    const event = keyboardEvent({ code: "Numpad1", key: "End" }, 35);

    // Not an enhanced key, unlike the main-block End.
    expect(mode.encode(event, true)).toBe("\x1b[35;79;0;1;0;1_");
  });

  it("keeps a layout's OEM key identity", () => {
    const event = keyboardEvent({ code: "Minus", key: "ß" }, 219);

    expect(mode.encode(event, true)).toBe("\x1b[219;12;223;1;0;1_");
  });

  it("falls back to the position table for a missing or IME-owned keyCode", () => {
    expect(
      mode.encode(keyboardEvent({ code: "KeyA", key: "a" }, 0), true),
    ).toBe("\x1b[65;30;97;1;0;1_");
    expect(
      mode.encode(keyboardEvent({ code: "KeyA", key: "a" }, 229), true),
    ).toBe("\x1b[65;30;97;1;0;1_");
  });

  it("ignores a keypress's keyCode, which is its character", () => {
    const event = keyboardEvent(
      { code: "KeyE", key: "é", type: "keypress" },
      233,
    );

    expect(mode.encode(event, true)).toBe("\x1b[69;18;233;1;0;1_");
    expect(mode.virtualKey(event)).toBe(69);
  });

  it("uses an explicit virtual key and treats 0 as absent", () => {
    const event = keyboardEvent(
      { code: "KeyE", key: "é", type: "keypress" },
      233,
    );

    expect(mode.encode(event, true, 90)).toBe("\x1b[90;18;233;1;0;1_");
    expect(mode.encode(event, true, 0)).toBe("\x1b[69;18;233;1;0;1_");
  });
});
