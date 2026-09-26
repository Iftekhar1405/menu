import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithDeadline,
  getAccessToken,
  restoreSession,
  setAccessToken,
} from "./api-client";

/**
 * Refresh tokens are rotated on every use, so presenting one twice is a
 * security event on the API's side and an error on ours. That makes a second
 * concurrent refresh strictly harmful: the first consumes the cookie and the
 * second is rejected, and a rejected `restoreSession()` is what bounces an
 * owner to the sign-in screen.
 *
 * This is not a rare interleaving. Every page load calls `restoreSession()`
 * once, and every 401 retried inside `request()` calls it again — and the
 * dashboard fetches `/auth/me` and `/businesses/mine` together, so a single
 * expired access token produces two at the same instant.
 */
describe("restoreSession", () => {
  let calls: number;

  beforeEach(() => {
    calls = 0;
    setAccessToken(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  /** A refresh endpoint that rotates: the second presentation is refused. */
  function rotatingRefresh(latencyMs = 10) {
    let spent = false;
    vi.stubGlobal("fetch", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, latencyMs));
      if (spent) {
        return new Response("", { status: 401 });
      }
      spent = true;
      return new Response(JSON.stringify({ accessToken: `token-${calls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  it("trades the cookie for an access token", async () => {
    rotatingRefresh();
    await expect(restoreSession()).resolves.toBe(true);
    expect(getAccessToken()).toBe("token-1");
  });

  it("makes one request when several callers ask at once", async () => {
    rotatingRefresh();

    const results = await Promise.all([
      restoreSession(),
      restoreSession(),
      restoreSession(),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(calls, "the cookie was presented more than once").toBe(1);
  });

  it("gives every concurrent caller the same token", async () => {
    rotatingRefresh();
    await Promise.all([restoreSession(), restoreSession()]);
    expect(getAccessToken()).toBe("token-1");
  });

  it("refreshes again once the first has settled", async () => {
    // A later refresh is a different event and must not be served from the
    // earlier one — the access token it issued has since expired.
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(JSON.stringify({ accessToken: `token-${calls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await restoreSession();
    await restoreSession();

    expect(calls).toBe(2);
    expect(getAccessToken()).toBe("token-2");
  });

  it("reports a rejected session to every concurrent caller", async () => {
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("", { status: 401 });
    });

    const results = await Promise.all([restoreSession(), restoreSession()]);

    expect(results).toEqual([false, false]);
    expect(calls).toBe(1);
  });

  /*
   * `false` means one specific thing — the server looked at the cookie and
   * said this session is not valid — because the only caller that acts on it
   * responds by sending the owner to the sign-in screen. A 500 or a dropped
   * connection is not that. Reporting those as `false` signs someone out of a
   * working account because the database hiccuped, which on restaurant wifi
   * happens several times a service.
   */
  it("refuses to call a server error a rejected session", async () => {
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("", { status: 500 });
    });

    await expect(restoreSession()).rejects.toThrow();
  });

  it("refuses to call an unreachable server a rejected session", async () => {
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    });

    await expect(restoreSession()).rejects.toThrow();
  });

  it("recovers once the server does", async () => {
    let broken = true;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (broken) return new Response("", { status: 503 });
      return new Response(JSON.stringify({ accessToken: "back" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(restoreSession()).rejects.toThrow();
    broken = false;
    await expect(restoreSession()).resolves.toBe(true);
  });

  it("does not leave a rejected refresh cached", async () => {
    let fail = true;
    vi.stubGlobal("fetch", async () => {
      calls++;
      if (fail) return new Response("", { status: 401 });
      return new Response(JSON.stringify({ accessToken: "recovered" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(restoreSession()).resolves.toBe(false);
    fail = false;
    await expect(restoreSession()).resolves.toBe(true);
    expect(getAccessToken()).toBe("recovered");
  });

  it("still makes one request when the network is down", async () => {
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw new Error("offline");
    });

    const results = await Promise.allSettled([restoreSession(), restoreSession()]);

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(calls, "the cookie was presented more than once").toBe(1);
  });
});

/**
 * Nothing in the browser stops a request that is never answered. A phone on
 * the wifi in a busy restaurant produces exactly that — not a refused
 * connection, which is reported in milliseconds, but an open socket nobody
 * ever replies on. Without a deadline the dashboard sits on "Loading…"
 * indefinitely, which looks identical to a slow page and offers no way out.
 */
describe("fetchWithDeadline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes a successful response straight through", async () => {
    vi.stubGlobal("fetch", async () => new Response("hello", { status: 200 }));
    const res = await fetchWithDeadline("/x", {}, 1_000);
    expect(await res.text()).toBe("hello");
  });

  it("gives up on a request nobody answers", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    await expect(fetchWithDeadline("/x", {}, 40)).rejects.toThrow();
  });

  it("says the request timed out rather than that it was aborted", async () => {
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    // "Aborted" reads as something the app chose to do. It did not.
    await expect(fetchWithDeadline("/x", {}, 40)).rejects.toThrow(/timed out|took too long/i);
  });

  it("leaves a real network error as itself", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchWithDeadline("/x", {}, 1_000)).rejects.toThrow(/Failed to fetch/);
  });
});
