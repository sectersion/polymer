// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// Unmount after every test: an un-cleaned root leaves React's scheduler
// a setImmediate render that fires after the jsdom environment tears
// down ("window is not defined"), failing the run nondeterministically
// (issue #31).
afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

// Components compile to classic JSX under vitest; provide the global.
vi.stubGlobal("React", React);

import { TaskBoard } from "../app/(console)/tasks/task-board";
import { ThemeToggle } from "../app/(console)/theme-toggle";
import { AgentsTable } from "../app/(console)/agents/agents-table";
import { ToastStack } from "../lib/toasts";

const TASKS = [
  {
    task_id: "a",
    title: "Alpha",
    status: "to_do",
    version: 1,
    lease_generation: 1,
  },
  {
    task_id: "b",
    title: "Beta",
    status: "done",
    version: 2,
    lease_generation: 1,
  },
];

describe("a11y pass", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: 3 }),
      })),
    );
  });

  it("task cards expose a keyboard Move-to select that PATCHes without drag", async () => {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(TaskBoard, { initial: TASKS as never }),
        React.createElement(ToastStack),
      ),
    );
    const select = screen.getByLabelText("Move Alpha to status");
    expect(select.tagName).toBe("SELECT");
    fireEvent.change(select, { target: { value: "in_progress" } });
    await screen.findByText(/Moved to in_progress/);
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/a",
      expect.objectContaining({ method: "PATCH" }),
    );
    // Status is never color-only: card carries an icon + text badge.
    expect(screen.getAllByText("To do").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
  });

  it("theme control is a tri-state radio group", () => {
    render(React.createElement(ThemeToggle));
    const group = screen.getByRole("radiogroup", { name: "Color theme" });
    expect(group).toBeDefined();
    for (const name of ["Light theme", "Dark theme", "System theme"]) {
      const radio = screen.getByRole("radio", { name });
      expect(radio.getAttribute("aria-checked")).toMatch(/true|false/);
    }
  });

  it("agents table headers carry scope (no misleading sort attrs); status has text+icon badge", () => {
    render(
      React.createElement(AgentsTable, {
        agents: [
          {
            agent_id: "abcdef123456",
            name: "w1",
            role: "coder",
            status: "working",
          },
        ] as never,
      }),
    );
    for (const th of document.querySelectorAll("th")) {
      expect(th.getAttribute("scope")).toBe("col");
      // Columns are not sortable: no aria-sort attribute at all.
      expect(th.hasAttribute("aria-sort")).toBe(false);
    }
    expect(screen.getAllByText("working").length).toBeGreaterThan(0);
  });
});
