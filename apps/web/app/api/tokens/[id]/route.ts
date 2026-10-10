import { proxyMutation } from "@/lib/proxy";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxyMutation(`/api/tokens/${id}`, { method: "DELETE" });
}
