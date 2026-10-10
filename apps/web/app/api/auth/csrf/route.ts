import { cookies } from "next/headers";
import { ADMIN_COOKIE, apiUrl } from "@/lib/polymer";

/**
 * Component 21: same-origin CSRF reader for the useEvents hook.
 * Plain session-authenticated GET proxy — no CSRF required to read
 * the token (it guards mutations, not reads).
 */
export async function GET(): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (token === undefined) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  const res = await fetch(`${apiUrl()}/api/auth/csrf`, {
    headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    cache: "no-store",
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
