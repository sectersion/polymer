// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ToastStack, pushToast, clearToasts } from "../lib/toasts";

beforeEach(() => {
  clearToasts();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("ToastStack", () => {
  it("renders success toast with Undo action", () => {
    const onAction = vi.fn();
    const { unmount } = render(<ToastStack />);
    try {
      act(() => {
        pushToast({ kind: "success", message: "Moved to done.", onAction });
      });
      expect(screen.getAllByText("Moved to done.").length).toBe(1);
      const undo = screen.getByRole("button", { name: "Undo" });
      fireEvent.click(undo);
      expect(onAction).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Moved to done.")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("renders copy button for one-time codes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    const { unmount } = render(<ToastStack />);
    try {
      act(() => {
        pushToast({
          kind: "success",
          message: "Init token minted.",
          copyText: "POLYMER_INIT_TOKEN=abc",
        });
      });
      expect(screen.getAllByText("POLYMER_INIT_TOKEN=abc").length).toBe(1);
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      await vi.waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("POLYMER_INIT_TOKEN=abc"),
      );
    } finally {
      unmount();
    }
  });

  it("renders error kind with alert role", () => {
    const { unmount } = render(<ToastStack />);
    try {
      act(() => {
        pushToast({ kind: "error", message: "Drop rejected." });
      });
      expect(screen.getAllByRole("alert").length).toBe(1);
    } finally {
      unmount();
    }
  });
});
