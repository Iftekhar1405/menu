import { proxyTableRequest } from "@/lib/table-session";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  return proxyTableRequest("/public/table/order/cancel", { method: "POST", body });
}
