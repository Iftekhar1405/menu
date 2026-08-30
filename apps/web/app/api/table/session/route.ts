import { proxyTableRequest } from "@/lib/table-session";

export async function GET() {
  return proxyTableRequest("/public/table/session");
}
