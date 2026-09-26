import { describe, expect, it } from "vitest";
import { buildCardSvg } from "./card.svg";
import { decodeQrFromSvg } from "./decode-qr.testutil";

const URL = "http://localhost:3000/t/9f8e7d6c5b4a";

/**
 * Characterisation tests. These pin the card's observable behaviour so the
 * QR-path extraction underneath it can be verified rather than hoped at.
 */
describe("buildCardSvg", () => {
  it("encodes the URL it was given", async () => {
    const svg = await buildCardSvg({ businessName: "Blue Tokai", url: URL });

    expect(decodeQrFromSvg(svg)).toBe(URL);
  });

  it("still scans with a logo and a table label on the card", async () => {
    const svg = await buildCardSvg({
      businessName: "Blue Tokai",
      url: URL,
      tableLabel: "Table 7",
      accent: "#7A3E9D",
    });

    expect(decodeQrFromSvg(svg)).toBe(URL);
    expect(svg).toContain("Table 7");
  });

  it("keeps the A6 canvas the print vendor is quoted on", async () => {
    const svg = await buildCardSvg({ businessName: "Blue Tokai", url: URL });

    expect(svg).toContain('viewBox="0 0 105 148"');
  });

  it("captions a table card for ordering and a menu card for browsing", async () => {
    const table = await buildCardSvg({ businessName: "X", url: URL, tableLabel: "7" });
    const menu = await buildCardSvg({ businessName: "X", url: URL });

    expect(table).toContain("Scan to order");
    expect(menu).toContain("Scan for menu");
  });

  it("escapes a business name that would otherwise break the markup", async () => {
    const svg = await buildCardSvg({ businessName: 'Ben & "Jerry"', url: URL });

    expect(svg).toContain("Ben &amp; &quot;Jerry&quot;");
  });
});
