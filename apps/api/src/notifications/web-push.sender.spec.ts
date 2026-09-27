import { describe, expect, it, vi } from "vitest";
import { WebPushSender, type PushDelivery } from "./web-push.sender";

const SUBS = [
  { endpoint: "https://push.example/a", p256dh: "k1", auth: "a1" },
  { endpoint: "https://push.example/b", p256dh: "k2", auth: "a2" },
];

const PAYLOAD = { id: "1", title: "New order · Table 12", body: "2× Dosa · ₹450" };

function senderWith(deliver: PushDelivery): WebPushSender {
  return new WebPushSender(deliver);
}

describe("WebPushSender", () => {
  it("delivers to every subscription", async () => {
    const deliver = vi.fn<PushDelivery>().mockResolvedValue(undefined);
    await senderWith(deliver).send(SUBS, PAYLOAD);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("reports a 410 endpoint as dead so it can be pruned", async () => {
    // A browser that cleared its site data leaves a subscription that will
    // never deliver again. Keeping it means every future order pays for a
    // guaranteed-failing request.
    const deliver = vi.fn<PushDelivery>(async (sub) => {
      if (sub.endpoint.endsWith("/b")) throw { statusCode: 410 };
    });
    const { dead } = await senderWith(deliver).send(SUBS, PAYLOAD);
    expect(dead).toEqual(["https://push.example/b"]);
  });

  it("treats 404 the same as 410", async () => {
    const deliver = vi.fn<PushDelivery>(async () => {
      throw { statusCode: 404 };
    });
    const { dead } = await senderWith(deliver).send(SUBS, PAYLOAD);
    expect(dead).toHaveLength(2);
  });

  it("does not prune on a transient failure", async () => {
    // A 500 from the push service, or a timeout, says nothing about whether
    // the device still exists. Dropping the subscription would silently
    // unsubscribe someone because their push provider had a bad minute.
    const deliver = vi.fn<PushDelivery>(async () => {
      throw { statusCode: 503 };
    });
    const { dead } = await senderWith(deliver).send(SUBS, PAYLOAD);
    expect(dead).toEqual([]);
  });

  it("keeps delivering after one subscription fails", async () => {
    const deliver = vi.fn<PushDelivery>(async (sub) => {
      if (sub.endpoint.endsWith("/a")) throw new Error("boom");
    });
    const { delivered } = await senderWith(deliver).send(SUBS, PAYLOAD);
    expect(delivered).toBe(1);
  });

  it("does nothing, without error, when there are no subscriptions", async () => {
    const deliver = vi.fn<PushDelivery>();
    const result = await senderWith(deliver).send([], PAYLOAD);
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: 0, dead: [] });
  });
});
