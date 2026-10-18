import type { NextRequest } from "next/server";
import { browserIsSecure, proxyMutation } from "@/lib/proxy";

export async function POST(req: NextRequest): Promise<Response> {
  return proxyMutation("/api/auth/logout", {
    browserSecure: browserIsSecure(req),
  });
}
