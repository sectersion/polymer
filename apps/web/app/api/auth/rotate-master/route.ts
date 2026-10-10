import { proxyMutation } from "@/lib/proxy";

export async function POST(): Promise<Response> {
  return proxyMutation("/api/auth/rotate-master", { body: {} });
}
