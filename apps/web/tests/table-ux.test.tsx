// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";

afterEach(cleanup);

vi.mock("next/link", async () => {
  // Async factory with its own React import: vi.mock factories are
  // hoisted above the file's imports, so referencing the top-level
  // React binding here throws "React is not defined".
  const React = await import("react");
  return {
    default: ({
      children,
      href,
    }: {
      children: React.ReactNode;
      href: string;
    }) => React.createElement("a", { href }, children),
  };
});

import { AgentsTable } from "../app/(console)/agents/agents-table";
import { AgentTelemetryTable } from "../app/(console)/telemetry/agent-telemetry-table";
import { UsageTable } from "../app/(console)/telemetry/usage-table";
import type {
  Agent,
  AgentTelemetryRow,
  TimelineEventRow,
} from "../lib/polymer";

function agent(i: number, status = "idle"): Agent {
  return {
    agent_id: `agent-${String(i).padStart(2, "0")}-id-0000-000000000000`,
    name: `agent-${String(i).padStart(2, "0")}`,
    role: i % 2 === 0 ? "coder" : "reviewer",
    parent_agent_id: null,
    status,
    heartbeat_timeout_seconds: 300,
    last_seen: "2026-10-18T00:00:00.000Z",
    connected_at: "2026-10-18T00:00:00.000Z",
    created_at: "2026-10-18T00:00:00.000Z",
  };
}

function usage(i: number): TimelineEventRow {
  return {
    usage_id: `usage-${i}`,
    agent_id: "agent-00",
    task_id: null,
    trace_id: `${String(i).repeat(8)}abcdef`,
    provider: "test",
    model: i % 2 === 0 ? "alpha-model" : "beta-model",
    input_tokens: 100,
    output_tokens: 50,
    reported_cost_micro_usd: 1000 + i,
    cost_source: "reported",
    recorded_at: `2026-10-1${i % 10}T00:00:00.000Z`,
  };
}

describe("Table UX (w3-tables)", () => {
  it("agents roster shows the onboarding empty state when empty", () => {
    render(<AgentsTable agents={[]} />);
    expect(screen.getByText("No agents yet")).toBeDefined();
    expect(screen.getByText(/mint a token in Onboarding/i)).toBeDefined();
  });

  it("agents roster filters by search and caps pages at ten", () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent(i));
    render(<AgentsTable agents={agents} />);
    expect(screen.getByText("Page 1 of 2")).toBeDefined();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText("Page 2 of 2")).toBeDefined();
    fireEvent.click(screen.getByText("Previous"));
    const search = screen.getByLabelText("Search agents");
    fireEvent.change(search, { target: { value: "agent-03" } });
    expect(screen.getByRole("link", { name: "agent-03" })).toBeDefined();
    expect(screen.queryByRole("link", { name: "agent-04" })).toBeNull();
  });

  it("agents roster shows a no-match empty state", () => {
    render(<AgentsTable agents={[agent(0)]} />);
    fireEvent.change(screen.getByLabelText("Search agents"), {
      target: { value: "zzz-no-such-agent" },
    });
    expect(screen.getByText("No agents match your search")).toBeDefined();
  });

  it("agent telemetry table shows its empty state when empty", () => {
    render(<AgentTelemetryTable rows={[]} />);
    expect(screen.getByText("No agent usage yet")).toBeDefined();
  });

  it("usage table shows its empty state when empty, filters otherwise", () => {
    const { unmount } = render(<UsageTable events={[]} />);
    expect(screen.getByText("No usage recorded yet")).toBeDefined();
    unmount();
    const rows: AgentTelemetryRow[] = [
      {
        agent_id: "a",
        name: "alpha",
        comments_sent: 1,
        tasks_created: 1,
        tokens_used: 10,
        cost_micro_usd: 5,
      },
    ];
    render(<AgentTelemetryTable rows={rows} />);
    expect(screen.getByText("alpha")).toBeDefined();
    const events = [usage(0), usage(1)];
    render(<UsageTable events={events} />);
    const tables = screen.getAllByRole("table");
    const usageTable = tables[tables.length - 1];
    expect(within(usageTable).getByText("alpha-model")).toBeDefined();
    fireEvent.change(screen.getByLabelText("Search usage"), {
      target: { value: "beta-model" },
    });
    expect(within(usageTable).queryByText("alpha-model")).toBeNull();
  });
});
