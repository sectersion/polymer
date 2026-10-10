"use client";

import { useEffect, useRef, useState } from "react";

export type EventsStatus = "live" | "reconnecting" | "polling";

export interface UseEventsOptions {
  /** Backend origin, e.g. http://127.0.0.1:8080. Defaults to same origin. */
  apiUrl?: string;
  /** Milliseconds between poll refreshes when the socket is down. */
  pollMs?: number;
}

/**
 * Component 21: the shared live-region hook. Opens the backend
 * `/api/events` WebSocket (session cookie rides automatically
 * same-origin; the CSRF token travels as `?csrf=` since browsers
 * cannot set upgrade headers), resumes with the last seen `event_id`
 * cursor, and calls `onEvent` for live events. When the socket is down
 * it polls `onPoll` every `pollMs` until the socket re-establishes —
 * so fleet state still refreshes without a manual reload, including
 * in cross-origin deployments where the browser cannot present the
 * host-locked session cookie to the backend.
 *
 * The CSRF token is fetched once from our own `/api/auth/csrf`
 * endpoint (same-origin, session-authenticated) — it never comes from
 * props or localStorage.
 */
export function useEvents(
  onEvent: (type: string) => void,
  onPoll: () => void,
  options: UseEventsOptions = {},
): EventsStatus {
  const { apiUrl = "", pollMs = 30000 } = options;
  const [status, setStatus] = useState<EventsStatus>("reconnecting");
  const cursor = useRef<string | undefined>(undefined);
  const handlers = useRef({ onEvent, onPoll });
  handlers.current = { onEvent, onPoll };

  useEffect(() => {
    let socket: WebSocket | undefined;
    let closed = false;

    async function connect(): Promise<void> {
      if (closed) return;
      let csrf = "";
      try {
        const res = await fetch("/api/auth/csrf");
        if (!res.ok) throw new Error(`csrf ${res.status}`);
        csrf = ((await res.json()) as { csrf_token: string }).csrf_token;
      } catch {
        // No session (or backend down): poll until one exists.
        setStatus("polling");
        return;
      }
      const base = apiUrl === "" ? window.location.origin : apiUrl;
      const wsUrl =
        `${base.replace(/^http/, "ws")}/api/events?csrf=${encodeURIComponent(csrf)}` +
        (cursor.current !== undefined ? `&cursor=${cursor.current}` : "");
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        setStatus("polling");
        return;
      }
      socket.onopen = () => {
        if (closed) return;
        setStatus("live");
      };
      socket.onmessage = (message) => {
        if (closed) return;
        try {
          const event = JSON.parse(message.data as string) as {
            event_id?: number;
            type?: string;
          };
          if (typeof event.event_id === "number") {
            cursor.current = String(event.event_id);
          }
          if (typeof event.type === "string") {
            handlers.current.onEvent(event.type);
          }
        } catch {
          // Malformed frame: ignore, the poll backstop covers us.
        }
      };
      const down = (): void => {
        if (closed) return;
        setStatus("polling");
        window.setTimeout(() => void connect(), 2000);
      };
      socket.onclose = down;
      socket.onerror = down;
    }

    const pollTimer = setInterval(() => {
      // Poll refresh only while the socket is down; live sockets push.
      setStatus((current) => {
        if (current !== "live" && !closed) handlers.current.onPoll();
        return current;
      });
    }, pollMs);

    void connect();
    return () => {
      closed = true;
      clearInterval(pollTimer);
      socket?.close();
    };
  }, [apiUrl, pollMs]);

  return status;
}
