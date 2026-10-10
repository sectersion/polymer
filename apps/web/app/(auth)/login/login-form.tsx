"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // The master credential is forwarded to the backend and discarded;
    // it is never stored anywhere in the browser.
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master_credential: secret }),
    });
    setBusy(false);
    if (!res.ok) {
      setError("Login failed — check the master credential and try again.");
      return;
    }
    setSecret("");
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-3">
      <label className="block text-sm font-medium">
        Master credential
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          className="mt-1 block w-full rounded-md border border-(--color-hairline) bg-white px-3 py-2 font-mono text-sm"
        />
      </label>
      {error !== null && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || secret === ""}
        className="rounded-md bg-(--color-accent) px-4 py-2 text-sm font-medium text-white hover:bg-(--color-accent-emphasis) disabled:opacity-50"
      >
        Log in
      </button>
    </form>
  );
}
