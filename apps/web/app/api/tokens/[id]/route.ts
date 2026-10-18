import { proxyMutation } from "@/lib/proxy";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyMutation(req, `/api/tokens/${id}`, { method: "DELETE" });
}
