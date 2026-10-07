import { describe, expect, it } from "vitest";
import {
  buildStartupMessage,
  DEFAULT_HOST,
  DEFAULT_PORT,
  VERSION,
} from "./index.js";

describe("server skeleton", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("builds a clean startup message with defaults", () => {
    const msg = buildStartupMessage();
    expect(msg).toContain("polymer server");
    expect(msg).toContain(VERSION);
    expect(msg).toContain(DEFAULT_HOST);
    expect(msg).toContain(String(DEFAULT_PORT));
  });

  it("builds a startup message with explicit host/port", () => {
    expect(buildStartupMessage("127.0.0.1", 3000)).toBe(
      "polymer server v0.0.0 starting on 127.0.0.1:3000",
    );
  });
});
