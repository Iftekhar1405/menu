import { afterEach, describe, expect, it } from "vitest";
import { requestOrigin, tableClaimPath } from "./table-claim";

describe("requestOrigin", () => {
  afterEach(() => {
    delete process.env.PUBLIC_MENU_BASE_URL;
  });

  it("uses the public host from forwarded headers, not localhost on request.url", () => {
    const request = new Request("http://localhost:3000/t/abc", {
      headers: {
        "x-forwarded-host": "menu.irad.solutions",
        "x-forwarded-proto": "https",
        host: "localhost:3000",
      },
    });
    expect(requestOrigin(request)).toBe("https://menu.irad.solutions");
  });

  it("does not fall back to localhost when PUBLIC_MENU_BASE_URL is unset", () => {
    delete process.env.PUBLIC_MENU_BASE_URL;
    const request = new Request("http://localhost:3000/t/abc", {
      headers: {
        host: "menu.irad.solutions",
      },
    });
    expect(requestOrigin(request)).toBe("https://menu.irad.solutions");
  });
});

describe("tableClaimPath", () => {
  it("turns a printed QR URL into a same-origin claim path", () => {
    expect(tableClaimPath("http://localhost:3000/t/9f8e7d6c5b4a")).toBe(
      "/t/9f8e7d6c5b4a",
    );
  });
});
