// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { BreakdownSection } from "../app/(console)/telemetry/breakdown-bars";

describe("BreakdownSection (telemetry depth)", () => {
  it("renders stacked buckets with exact figures and empty state", () => {
    const { rerender } = render(
      <BreakdownSection
        title="Cost by model"
        buckets={[
          { key: "m1", tokens_used: 165, cost_micro_usd: 2600, spans: 2 },
          { key: "unknown", tokens_used: 2, cost_micro_usd: 0, spans: 1 },
        ]}
      />,
    );
    expect(screen.getByText("Cost by model")).toBeDefined();
    expect(screen.getByText("m1")).toBeDefined();
    expect(screen.getByText("unknown")).toBeDefined();
    expect(screen.getByText(/2,600 µUSD/)).toBeDefined();
    expect(screen.getByText(/165 tok/)).toBeDefined();

    rerender(<BreakdownSection title="Cost by provider" buckets={[]} />);
    expect(screen.getByText("No usage recorded.")).toBeDefined();
  });
});
