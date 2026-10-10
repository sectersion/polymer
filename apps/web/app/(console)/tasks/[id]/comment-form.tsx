"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CommentForm({ taskId }: { taskId: string }): React.JSX.Element {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // Human comments post with sender_type "human" server-side.
    const res = await fetch(`/api/tasks/${taskId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(`Comment rejected (${body.error ?? res.status}).`);
      return;
    }
    setContent("");
    router.refresh();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write a comment as a human operator…"
        rows={3}
        className="block w-full rounded-md border border-(--color-hairline) bg-white px-3 py-2 text-sm"
      />
      {error !== null && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy || content.trim() === ""}
        className="rounded-md bg-(--color-accent) px-3 py-1 text-sm text-white hover:bg-(--color-accent-emphasis) disabled:opacity-50"
      >
        Post comment
      </button>
    </form>
  );
}
