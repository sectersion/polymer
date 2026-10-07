import { describe, expect, it } from "vitest";
import { listen } from "./server.js";

describe("HTTP health (component 1)", () => {
  it("GET /health returns { ok: true }", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("unknown route returns 404", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
