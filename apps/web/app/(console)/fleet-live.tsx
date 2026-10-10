"use client";

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
 */
export function FleetLive(): React.JSX.Element {
  const router = useRouter();
  const status = useEvents(
    () => router.refresh(),
    () => router.refresh(),
  );
  return (
    <p
      className="mt-4 inline-flex items-center gap-1.5 text-xs text-gray-500"
      data-testid="fleet-live"
      data-status={status}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          status === "live" ? "bg-green-500" : "bg-gray-400"
        }`}
      />
      {STATUS_LABEL[status]}
    </p>
  );
}
