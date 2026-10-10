"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton(): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function logout(): Promise<void> {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return (
    <button
      type="button"
      onClick={() => void logout()}
      disabled={busy}
      className="rounded-md border border-(--color-hairline) bg-white px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
    >
      Logout
    </button>
  );
}
