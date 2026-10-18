"use client";

import React, { useEffect, useState } from "react";

export interface ToastInput {
  kind: "success" | "error";
  message: string;
  /** Optional undo action (task moves). */
  actionLabel?: string;
  onAction?: () => void;
  /** Optional one-time code shown with a Copy button. */
  copyText?: string;
  durationMs?: number;
}

interface Toast extends ToastInput {
  id: number;
  kind: "success" | "error";
  message: string;
}

let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function pushToast(input: ToastInput): number {
  const id = nextId++;
  toasts = [...toasts, { ...input, id }];
  emit();
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function clearToasts(): void {
  toasts = [];
  emit();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

function ToastItem({ toast }: { toast: Toast }): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(
      () => dismissToast(toast.id),
      toast.durationMs ?? 6000,
    );
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [toast.id, toast.durationMs]);

  return (
    <div
      role={toast.kind === "error" ? "alert" : "status"}
      data-testid={`toast-${toast.id}`}
      data-kind={toast.kind}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 250ms ease-out, transform 250ms ease-out",
      }}
      className={`pointer-events-auto w-full max-w-sm rounded-lg border bg-white p-3 shadow-lg ${
        toast.kind === "error" ? "border-red-300" : "border-(--color-hairline)"
      }`}
    >
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm">{toast.message}</p>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissToast(toast.id)}
          className="rounded px-1 text-sm text-gray-400 hover:text-gray-700"
        >
          ×
        </button>
      </div>
      {toast.copyText !== undefined && (
        <pre className="mt-2 overflow-x-auto rounded bg-gray-900 p-2 font-mono text-xs break-all text-green-300">
          {toast.copyText}
        </pre>
      )}
      {(toast.onAction !== undefined || toast.copyText !== undefined) && (
        <div className="mt-2 flex gap-2">
          {toast.onAction !== undefined && (
            <button
              type="button"
              onClick={() => {
                toast.onAction?.();
                dismissToast(toast.id);
              }}
              className="rounded-md border border-(--color-hairline) px-2 py-1 text-xs font-medium hover:bg-gray-50"
            >
              {toast.actionLabel ?? "Undo"}
            </button>
          )}
          {toast.copyText !== undefined && (
            <button
              type="button"
              onClick={() =>
                void copyText(toast.copyText ?? "").then((ok) => setCopied(ok))
              }
              className="rounded-md border border-(--color-hairline) px-2 py-1 text-xs font-medium hover:bg-gray-50"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lightweight toast stack: success/error, Undo action, Copy for one-time codes. */
export function ToastStack(): React.JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  return (
    <>
      <style>{`@media (prefers-reduced-motion: reduce){[data-testid^="toast-"]{transition:none !important;transform:none !important}}`}</style>
      <div
        aria-live="polite"
        data-testid="toast-stack"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </div>
    </>
  );
}
