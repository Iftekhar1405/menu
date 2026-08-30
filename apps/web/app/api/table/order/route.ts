import { proxyTableRequest } from "@/lib/table-session";

export async function GET() {
  return proxyTableRequest("/public/table/order");
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  return proxyTableRequest("/public/table/order", { method: "POST", body });
}
