import type { NextRequest } from "next/server";
import { apiUrl } from "@/lib/polymer";

/**
 * Component 20: login proxy. Forwards the master credential to the
 * backend and relays the session Set-Cookie; the credential itself is
 * never stored or displayed.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => null)) as {
    master_credential?: unknown;
  } | null;
  const res = await fetch(`${apiUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: body?.master_credential }),
  });
  const text = await res.text();
  const headers = new Headers({ "content-type": "application/json" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) headers.set("set-cookie", setCookie);
  return new Response(text, { status: res.status, headers });
}
