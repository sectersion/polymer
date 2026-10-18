import type { NextRequest } from "next/server";
import { proxyMutation } from "@/lib/proxy";

export async function POST(req: NextRequest): Promise<Response> {
  return proxyMutation(req, "/api/auth/logout");
}
