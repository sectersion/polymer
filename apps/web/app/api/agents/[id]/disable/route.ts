import { proxyMutation } from "@/lib/proxy";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyMutation(req, `/api/agents/${id}/disable`);
}
