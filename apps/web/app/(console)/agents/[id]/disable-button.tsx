"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function DisableButton({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function disable(): Promise<void> {
    setBusy(true);
    const res = await fetch(`/api/agents/${agentId}/disable`, {
      method: "POST",
    });
    const body = (await res.json().catch(() => ({}))) as {
      disabled_count?: number;
    };
    setBusy(false);
    if (!res.ok) {
      setResult("Disable failed — see server logs.");
      return;
    }
    setResult(`Disabled ${body.disabled_count ?? 0} agent(s) in the subtree.`);
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="rounded-md border border-red-300 bg-white px-3 py-1 text-sm text-red-700 hover:bg-red-50"
        >
          Disable subtree
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/3 w-full max-w-sm -translate-x-1/2 rounded-lg bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-semibold">
            Disable {agentName}?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-gray-600">
            This disables the agent and its whole subtree, releasing their task
            leases. The action is audit-logged.
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
              onClick={() => void disable()}
              disabled={busy}
              className="rounded-md bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              Disable
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      {result !== null && <p className="mt-2 text-sm">{result}</p>}
    </Dialog.Root>
  );
}
