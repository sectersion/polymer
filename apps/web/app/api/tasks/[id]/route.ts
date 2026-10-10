import { proxyMutation } from "@/lib/proxy";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as unknown;
  return proxyMutation(`/api/tasks/${id}`, { method: "PATCH", body });
}
