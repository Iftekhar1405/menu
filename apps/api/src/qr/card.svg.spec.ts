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

  it("keeps a logo-table label above the QR and still scans", async () => {
    const svg = await buildCardSvg({
      businessName: "Blue Tokai",
      url: URL,
      tableLabel: "Table 7",
      logoDataUri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL0NwAAAABJRU5ErkJggg==",
      accent: "#7A3E9D",
    });

    expect(decodeQrFromSvg(svg)).toBe(URL);
    expect(svg).toContain("Table 7");
    // Logo cards put the business baseline at 45 and the table chip at
    // 48–59. The QR starts at 63, leaving a clear 4mm gap.
    expect(svg).toContain('y="48" width="32" height="11"');
    expect(svg).toContain('y="55.5" text-anchor="middle"');
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
