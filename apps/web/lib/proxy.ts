import { cookies } from "next/headers";
import { ADMIN_COOKIE, apiUrl } from "@/lib/polymer";

/**
 * Component 20: mutation proxy. Browser forms POST here; the handler
 * forwards the session cookie, fetches the session CSRF server-side,
 * and relays the backend response (including Set-Cookie). The browser
 * never sees the CSRF token and never touches the backend directly.
 */
export async function proxyMutation(
  backendPath: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (token === undefined) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  const csrfRes = await fetch(`${apiUrl()}/api/auth/csrf`, {
    headers: { cookie: `${ADMIN_COOKIE}=${token}` },
  });
  if (!csrfRes.ok) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  const { csrf_token } = (await csrfRes.json()) as { csrf_token: string };
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (init?.body !== undefined && body === undefined) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const res = await fetch(`${apiUrl()}${backendPath}`, {
    method: init?.method ?? "POST",
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
      "x-csrf-token": csrf_token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body,
  });
  const text = await res.text();
  const headers = new Headers({ "content-type": "application/json" });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie !== null) headers.set("set-cookie", setCookie);
  return new Response(text, { status: res.status, headers });
}
