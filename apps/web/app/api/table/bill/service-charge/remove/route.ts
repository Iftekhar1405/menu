import { proxyTableRequest } from "@/lib/table-session";

export async function POST() {
  return proxyTableRequest("/public/table/bill/service-charge/remove", {
    method: "POST",
  });
}
