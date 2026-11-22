import { describe, expect, it } from "vitest";
import { shortcutModifier } from "./shortcut-label";

describe("console navigation shortcut tooltip", () => {
  it("shows Command on macOS", () => {
    expect(shortcutModifier("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("⌘");
  });

  it("shows Ctrl on Windows and Linux", () => {
    expect(shortcutModifier("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Ctrl");
    expect(shortcutModifier("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl");
  });
});
