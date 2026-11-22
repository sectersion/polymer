import { describe, expect, it } from "vitest";
import { shortcutModifier } from "./shortcut-label";

describe("console navigation shortcut tooltip", () => {
  it("shows Command on macOS", () => {
    expect(shortcutModifier("Mozilla/5.0 (Macintosh)")).toBe("⌘");
  });

  it("shows Ctrl on Windows and Linux", () => {
    expect(shortcutModifier("Mozilla/5.0 (Windows NT)")).toBe("Ctrl");
    expect(shortcutModifier("Mozilla/5.0 (Linux)")).toBe("Ctrl");
  });
});
