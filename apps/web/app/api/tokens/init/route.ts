import { proxyMutation } from "@/lib/proxy";

export async function POST(req: Request): Promise<Response> {
  return proxyMutation(req, "/api/tokens/init", { body: {} });
}
