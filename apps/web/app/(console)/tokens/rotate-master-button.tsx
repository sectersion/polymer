"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function RotateMasterButton(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function rotate(): Promise<void> {
    setBusy(true);
    const res = await fetch("/api/auth/rotate-master", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      master_credential?: string;
    };
    setBusy(false);
    if (res.ok && typeof body.master_credential === "string") {
      // Shown exactly once, never stored.
      setRevealed(body.master_credential);
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="rounded-md border border-red-300 bg-white px-3 py-1 text-sm text-red-700 hover:bg-red-50"
          >
            Rotate master credential
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/3 w-full max-w-sm -translate-x-1/2 rounded-lg bg-white p-6 shadow-xl">
            <Dialog.Title className="text-lg font-semibold">
              Rotate the master credential?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-gray-600">
              This invalidates the old credential and revokes every live admin
              session, including this one. You will need to log in again.
            </Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md border border-(--color-hairline) px-3 py-1 text-sm"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => void rotate()}
                disabled={busy}
                className="rounded-md bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                Rotate
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {revealed !== null && (
        <p className="mt-2 rounded-md border border-red-300 bg-red-50 p-3 font-mono text-xs break-all">
          New master credential (save it now — it is never shown again):{" "}
          {revealed}
        </p>
      )}
    </div>
  );
}
