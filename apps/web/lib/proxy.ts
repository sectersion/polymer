import { cookies } from "next/headers";
import { ADMIN_COOKIE, ADMIN_COOKIE_HTTP, apiUrl } from "@/lib/polymer";

/**
 * Relay backend Set-Cookie headers to the browser. The backend marks the
 * session cookie Secure whenever its own listener isn't loopback
 * (e.g. 0.0.0.0 in compose) — but the browser reaches *us* over plain
 * HTTP on loopback, where a Secure cookie is silently dropped and login
 * looks like "box empties, nothing happens". Worse, a `__Host-` cookie
 * without Secure is rejected outright. So on non-TLS browser
 * connections the session is stored under a plain fallback name;
 * server-to-backend calls still use the `__Host-` name.
 *
 * The fallback cookie is a loopback-only concession: it is only ever
 * emitted when the browser connection itself is plain HTTP, which in
 * this deployment means 127.0.0.1. Behind a TLS-terminating proxy the
 * connection must be detected as secure (see browserIsSecure) so the
 * hardened `__Host-` name is kept.
 */
export function relaySetCookie(
  headers: Headers,
  res: Response,
  browserSecure: boolean,
): void {
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie") !== null
        ? [res.headers.get("set-cookie") as string]
        : [];
  for (const setCookie of setCookies) {
    if (browserSecure) {
      headers.append("set-cookie", setCookie);
      continue;
    }
    headers.append(
      "set-cookie",
      setCookie
        .replace(/^__Host-polymer_admin=/, `${ADMIN_COOKIE_HTTP}=`)
        .replace(/;\s*Secure(?=;|$)/gi, ""),
    );
  }
}

/**
 * True when the browser reached us over TLS. `X-Forwarded-Proto` is only
 * honored when the web server sits behind a known TLS-terminating proxy
 * (POLYMER_TRUST_PROXY=true) — otherwise any direct client could spoof it
 * to force a cookie downgrade (or a broken Secure cookie over HTTP).
 */
export function browserIsSecure(req: Request): boolean {
  if (process.env.POLYMER_TRUST_PROXY === "true") {
    const proto = req.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    if (proto === "https") return true;
    if (proto === "http") return false;
  }
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return true;
  }
}

/**
 * Component 20: mutation proxy. Browser forms POST here; the handler
 * forwards the session cookie, fetches the session CSRF server-side,
 * and relays the backend response (including Set-Cookie). The browser
 * never sees the CSRF token and never touches the backend directly.
 * The request is required so the secure-context decision cannot be
 * forgotten by callers (it defaults safe: unknown means secure).
 */
export async function proxyMutation(
  req: Request,
  backendPath: string,
  init?: { method?: string; body?: unknown },
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
  relaySetCookie(headers, res, browserIsSecure(req));
  return new Response(text, { status: res.status, headers });
}
