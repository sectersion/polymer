import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ADMIN_COOKIE = "__Host-polymer_admin";

function apiUrl(): string {
  return (process.env.POLYMER_API_URL ?? "http://127.0.0.1:8080").replace(
    /\/$/,
    "",
  );
}

/**
 * Component 20: the session gate. Every console page needs a live
 * administrator session; unauthenticated visits redirect to Login.
 * The check is a real backend round-trip (not cookie presence), so a
 * revoked or expired session redirects too.
 */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (token === undefined) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}/api/agents?limit=1`, {
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    });
  } catch {
    // Backend unreachable: fail closed to Login rather than leaking
    // console chrome (or a stack trace) to an unauthenticated visitor.
    return NextResponse.redirect(new URL("/login", req.url));
  }
  if (res.status === 401) {
    const redirect = NextResponse.redirect(new URL("/login", req.url));
    // Drop the dead credential on the way out.
    redirect.cookies.delete(ADMIN_COOKIE);
    return redirect;
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|api|_next/static|_next/image|favicon.ico).*)"],
};
