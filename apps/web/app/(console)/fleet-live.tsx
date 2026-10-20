"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useEvents, type EventsStatus } from "@/lib/use-events";

const STATUS_LABEL: Record<EventsStatus, string> = {
  live: "Live",
  reconnecting: "Connecting…",
  polling: "Polling every 30s",
};

/**
 * Component 21: the Fleet live region. Task/agent/comment events
 * refresh the server-rendered counts without a manual reload; when
 * the socket is down the 30s poll fallback refreshes instead.
 * Rapid pushes are coalesced (~1s window) into a single refresh.
 */
export function FleetLive(): React.JSX.Element {
  const router = useRouter();
  const [announcement, setAnnouncement] = useState("Fleet updates connected.");
  const onEvent = useCallback(
    (type: string) => {
      setAnnouncement(`Fleet updated: ${type}.`);
      router.refresh();
    },
    [router],
  );
  const onPoll = useCallback(() => {
    router.refresh();
  }, [router]);
  const status = useEvents(onEvent, onPoll);
  return (
    <>
      <p
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-(--color-fg-muted)"
        data-testid="fleet-live"
        data-status={status}
      >
        <span className="relative flex h-2 w-2" aria-hidden="true">
          {status === "live" ? (
            <>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </>
          ) : (
            <span className="relative inline-flex h-2 w-2 rounded-full bg-(--color-fg-subtle)" />
          )}
        </span>
        {STATUS_LABEL[status]}
      </p>
      <p aria-live="polite" role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
