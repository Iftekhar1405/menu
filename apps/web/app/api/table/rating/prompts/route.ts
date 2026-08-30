import { proxyTableRequest } from "@/lib/table-session";

export async function GET(request: Request) {
  const stars = new URL(request.url).searchParams.get("stars") ?? "5";
  return proxyTableRequest(
    `/public/table/rating/prompts?stars=${encodeURIComponent(stars)}`,
  );
}
