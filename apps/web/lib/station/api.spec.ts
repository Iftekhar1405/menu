import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { stationApi } from "./api";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

const { api } = await import("@/lib/api-client");

describe("stationApi.claim", () => {
  it("turns a 409 into 'taken' rather than throwing", async () => {
    // The loop treats this as "my neighbour tab printed it". If it threw,
    // the station would show an error for a ticket that came out fine.
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, "Conflict"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).resolves.toBe("taken");
  });

  it("lets a 410 through, because that one must stop the station", async () => {
    // A revoked machine has to notice. Swallowing this would leave a
    // retired station polling forever.
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(410, "Gone"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).rejects.toBeInstanceOf(ApiError);
  });

  it("lets every other failure through", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(500, "Boom"));
    await expect(stationApi("b1", "s1").claim("1", "token", false)).rejects.toBeInstanceOf(ApiError);
  });
});
