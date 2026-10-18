import { cookies } from "next/headers";
import { ADMIN_COOKIE, ADMIN_COOKIE_HTTP, apiUrl } from "@/lib/polymer";

/**
 * Relay a backend Set-Cookie to the browser. The backend marks the
 * session cookie Secure whenever its own listener isn't loopback
 * (e.g. 0.0.0.0 in compose) — but the browser reaches *us* over plain
 * HTTP on loopback, where a Secure cookie is silently dropped and login
 * looks like "box empties, nothing happens". Worse, a `__Host-` cookie
 * without Secure is rejected outright. So on non-TLS browser
 * connections the session is stored under a plain fallback name;
 * server-to-backend calls still use the `__Host-` name.
 */
export function relaySetCookie(
  headers: Headers,
  res: Response,
  browserSecure: boolean,
): void {
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) return;
  if (browserSecure) {
    headers.set("set-cookie", setCookie);
    return;
  }
  headers.set(
    "set-cookie",
    setCookie
      .replace(/^__Host-polymer_admin=/, `${ADMIN_COOKIE_HTTP}=`)
      .replace(/;\s*Secure(?=;|$)/gi, ""),
  );
}

/** True when the browser reached us over TLS (direct or via proxy). */
export function browserIsSecure(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto === "https") return true;
  if (proto === "http") return false;
  return new URL(req.url).protocol === "https:";
}

/**
 * Component 20: mutation proxy. Browser forms POST here; the handler
 * forwards the session cookie, fetches the session CSRF server-side,
 * and relays the backend response (including Set-Cookie). The browser
 * never sees the CSRF token and never touches the backend directly.
 */
export async function proxyMutation(
  backendPath: string,
  init?: { method?: string; body?: unknown; browserSecure?: boolean },
): Promise<Response> {
  const jar = await cookies();
  const token =
    jar.get(ADMIN_COOKIE)?.value ?? jar.get(ADMIN_COOKIE_HTTP)?.value;
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
  relaySetCookie(headers, res, init?.browserSecure ?? false);
  return new Response(text, { status: res.status, headers });
}
