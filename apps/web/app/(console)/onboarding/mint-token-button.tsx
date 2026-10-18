"use client";

import { useEffect, useState } from "react";
import { ToastStack, pushToast } from "@/lib/toasts";

interface MintedToken {
  init_token_id: string;
  init_token: string;
  /** Additive combined `<id>:<code>` line from POST /api/tokens/init. */
  onboarding_token?: string;
  expires_in: number;
  expires_at: string;
}

function secondsLeft(expiresAt: string): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000));
}

/**
 * Component 20: the onboarding flow. "Mint init token" calls the
 * backend through the session; the OTP renders once inside a
 * copy-paste prompt with a live countdown from the server-provided
 * expires_at. A used/expired OTP is never reshown — minting replaces
 * the display.
 */
export function MintTokenButton(): React.JSX.Element {
  const [token, setToken] = useState<MintedToken | null>(null);
  const [busy, setBusy] = useState(false);
  // Ticks once a second while a token is displayed so the countdown
  // re-renders from the server-provided expires_at.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (token === null) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [token]);

  async function mint(): Promise<void> {
    setBusy(true);
    const res = await fetch("/api/tokens/init", { method: "POST" });
    const body = (await res
      .json()
      .catch(() => ({}))) as Partial<MintedToken> & {
      error?: string;
    };
    setBusy(false);
    if (!res.ok || typeof body.init_token !== "string") {
      pushToast({
        kind: "error",
        message: `Mint failed (${body.error ?? res.status}).`,
      });
      return;
    }
    const minted = body as MintedToken;
    setToken(minted);
    pushToast({
      kind: "success",
      message: "Init token minted — shown once, copy it now.",
      copyText: `POLYMER_INIT_TOKEN_ID=${minted.init_token_id}\nPOLYMER_INIT_TOKEN=${minted.init_token}`,
      durationMs: 30000,
    });
  }

  const remaining = token !== null ? secondsLeft(token.expires_at) : 0;
  // Single copyable enrollment prompt: server URL plus the minted
  // OTPs, so a fresh agent gets full context in one paste. The
  // server URL is this console's origin.
  const serverUrl = typeof window !== "undefined" ? window.location.origin : "";
  const prompt =
    token === null
      ? ""
      : [
          `Enroll a new Polymer agent against ${serverUrl}.`,
          `One-time init OTP (single use, expires in ${remaining}s, shown once):`,
          `POLYMER_SERVER=${serverUrl}`,
          `POLYMER_INIT_TOKEN_ID=${token.init_token_id}`,
          `POLYMER_INIT_TOKEN=${token.init_token}`,
          `POLYMER_ONBOARDING_TOKEN=${token.onboarding_token ?? `${token.init_token_id}:${token.init_token}`}`,
          `Run: polymer-install --server "${serverUrl}" --name <agent-name> --init-token-id ${token.init_token_id} --init-token ${token.init_token} --dir .`,
        ].join("\n");

  return (
    <div>
      <button
        type="button"
        onClick={() => void mint()}
        disabled={busy}
        className="rounded-md bg-(--color-accent) px-4 py-2 text-sm font-medium text-white hover:bg-(--color-accent-emphasis) disabled:opacity-50"
      >
        Mint init token
      </button>
      <ToastStack />
      {token !== null && remaining > 0 && (
        <div className="mt-4 max-w-md rounded-lg border border-(--color-hairline) bg-white p-4 shadow-sm">
          <p className="text-sm text-gray-500">
            Expires in {remaining}s — a used or expired OTP is never reshown.
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-gray-900 p-3 font-mono text-xs text-green-300">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  );
}
