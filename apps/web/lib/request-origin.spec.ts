import { describe, expect, it } from "vitest";
import { requestOrigin } from "./request-origin";

/**
 * The scan target redirects the diner onward and sets their table cookie on
 * the same response. Both have to land on the host they actually scanned:
 * a cookie written for host A is not sent to host B, so an origin taken from
 * anywhere but the request is a session that silently disappears.
 */
describe("requestOrigin", () => {
  it("uses the host the request arrived on", () => {
    const req = new Request("https://menu.irad.solutions/t/abc123");
    expect(requestOrigin(req)).toBe("https://menu.irad.solutions");
  });

  it("prefers the proxy's forwarded host over the internal one", () => {
    // On Vercel the function sees an internal host; the diner's address bar
    // says the custom domain, and that is where the cookie is being written.
    const req = new Request("https://menu-web.vercel.app/t/abc123", {
      headers: {
        "x-forwarded-host": "menu.irad.solutions",
        "x-forwarded-proto": "https",
      },
    });
    expect(requestOrigin(req)).toBe("https://menu.irad.solutions");
  });

  it("takes the first hop when proxies chain the forwarded header", () => {
    const req = new Request("https://internal/t/abc123", {
      headers: { "x-forwarded-host": "menu.irad.solutions, internal.local" },
    });
    expect(requestOrigin(req)).toBe("https://menu.irad.solutions");
  });

  it("still works on plain http in local development", () => {
    const req = new Request("http://localhost:3000/t/abc123");
    expect(requestOrigin(req)).toBe("http://localhost:3000");
  });

  it("ignores PUBLIC_MENU_BASE_URL, which is the API's variable", () => {
    // The live bug: this variable is set for the API (it stamps the QR) and
    // absent from the web deployment, so reading it here sent every scan to
    // localhost. The request is the only trustworthy source.
    const previous = process.env.PUBLIC_MENU_BASE_URL;
    process.env.PUBLIC_MENU_BASE_URL = "http://localhost:3000";
    try {
      const req = new Request("https://menu.irad.solutions/t/abc123");
      expect(requestOrigin(req)).toBe("https://menu.irad.solutions");
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_MENU_BASE_URL;
      else process.env.PUBLIC_MENU_BASE_URL = previous;
    }
  });
});
