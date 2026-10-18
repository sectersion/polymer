// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, act } from "@testing-library/react";
import React from "react";
import { useEvents } from "../lib/use-events";

type MsgHandler = (message: { data: string }) => void;

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: MsgHandler | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(..._args: unknown[]) {
    FakeSocket.instances.push(this);
  }
  close(): void {}
  emit(type: string, id: number): void {
    this.onmessage?.({ data: JSON.stringify({ event_id: id, type }) });
  }
}

function Probe({
  onEvent,
  coalesceMs,
}: {
  onEvent: (type: string) => void;
  coalesceMs: number;
}): React.JSX.Element {
  const status = useEvents(onEvent, () => {}, { pollMs: 60000, coalesceMs });
  return <p data-testid="probe" data-status={status} />;
}

describe("useEvents coalescing", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ csrf_token: "test-csrf" }),
      })),
    );
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("coalesces rapid pushes into a single onEvent call", async () => {
    const onEvent = vi.fn();
    render(React.createElement(Probe, { onEvent, coalesceMs: 1000 }));
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeSocket.instances[0];
    expect(socket).toBeDefined();
    act(() => {
      socket.onopen?.();
    });
    act(() => {
      socket.emit("task.created", 1);
      socket.emit("task.updated", 2);
      socket.emit("comment.created", 3);
    });
    expect(onEvent).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("comment.created");
  });

  it("fires a second batch after the window elapses", async () => {
    const onEvent = vi.fn();
    render(React.createElement(Probe, { onEvent, coalesceMs: 1000 }));
    await act(async () => {
      await Promise.resolve();
    });
    const socket = FakeSocket.instances[0];
    act(() => {
      socket.onopen?.();
    });
    act(() => {
      socket.emit("task.created", 1);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    act(() => {
      socket.emit("task.updated", 2);
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onEvent).toHaveBeenCalledTimes(2);
  });
});
