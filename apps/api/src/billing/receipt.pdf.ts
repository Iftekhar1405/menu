import PDFDocument from "pdfkit";
import type { Bill } from "./billing.service";

/**
 * A thermal-receipt-shaped PDF: 80mm wide, height grown to fit.
 *
 * Deliberately not A4. This gets printed on a counter printer or read on a
 * phone, and an A4 page with three lines of content on it looks like a form
 * rather than a bill.
 */
const MM = 2.8346; // points per millimetre
const WIDTH = 80 * MM;
const PAD = 6 * MM;
const INNER = WIDTH - PAD * 2;

export function buildReceiptPdf(bill: Bill): Promise<Buffer> {
  // Height is estimated generously and the page is not reflowed: pdfkit needs
  // a size up front, and a little extra whitespace at the foot of a receipt
  // costs nothing.
  const height = (120 + bill.lines.length * 14 + (bill.receiptFooter ? 30 : 0)) * MM;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [WIDTH, height], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    let y = PAD;

    const line = (
      text: string,
      opts: { size?: number; bold?: boolean; align?: "left" | "center" | "right"; gap?: number } = {},
    ) => {
      doc
        .font(opts.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(opts.size ?? 8)
        .text(text, PAD, y, { width: INNER, align: opts.align ?? "left" });
      y = doc.y + (opts.gap ?? 1);
    };

    const row = (left: string, right: string, bold = false, size = 8) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
      const startY = y;
      doc.text(left, PAD, startY, { width: INNER - 60, align: "left" });
      const leftBottom = doc.y;
      doc.text(right, PAD + INNER - 60, startY, { width: 60, align: "right" });
      y = Math.max(leftBottom, doc.y) + 1;
    };

    const rule = () => {
      doc
        .moveTo(PAD, y + 2)
        .lineTo(PAD + INNER, y + 2)
        .lineWidth(0.5)
        .strokeColor("#cccccc")
        .stroke();
      y += 6;
    };

    const money = (v: string) => `${bill.currency === "INR" ? "₹" : ""}${v}`;

    // ── Header ──
    line(bill.business.name, { size: 12, bold: true, align: "center", gap: 2 });

    const address = [
      bill.business.addressLine1,
      bill.business.addressLine2,
      [bill.business.city, bill.business.state].filter(Boolean).join(", "),
      bill.business.postalCode,
    ]
      .filter(Boolean)
      .join("\n");
    if (address) line(address, { size: 7, align: "center", gap: 2 });

    if (bill.business.gstin) {
      line(`GSTIN: ${bill.business.gstin}`, { size: 7, align: "center", gap: 2 });
    }

    rule();

    row(`Bill #${bill.billNumber}`, `Table ${bill.tableLabel}`);
    line(new Date(bill.issuedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), {
      size: 7,
      gap: 2,
    });

    rule();

    // ── Lines ──
    for (const item of bill.lines) {
      const name = item.variant ? `${item.name} (${item.variant})` : item.name;
      row(`${item.quantity} x ${name}`, money(item.lineTotal));
    }

    rule();

    // ── Totals ──
    row(bill.pricesIncludeTax ? "Subtotal (before tax)" : "Subtotal", money(bill.subtotal));

    if (Number(bill.taxTotal) > 0) {
      row(bill.taxLabel, money(bill.taxTotal));
    }

    if (Number(bill.serviceCharge) > 0) {
      row(`Service charge (${bill.serviceChargeRate}%)`, money(bill.serviceCharge));
      // Stated on the bill itself, not just in the app: an automatic service
      // charge is not permitted, and a diner reading a printed receipt should
      // be told the same thing a diner reading the screen is told.
      line("Service charge is optional and can be removed on request.", {
        size: 6,
        gap: 2,
      });
    }

    if (Number(bill.roundOff) !== 0) {
      row("Rounding", money(bill.roundOff));
    }

    rule();
    row("TOTAL", money(bill.total), true, 11);
    rule();

    if (bill.receiptFooter) {
      line(bill.receiptFooter, { size: 7, align: "center", gap: 3 });
    }

    // Not a tax invoice, and the receipt says so rather than leaving a
    // GST-registered business to discover it from a customer.
    line("This is a receipt, not a GST tax invoice.", {
      size: 6,
      align: "center",
      gap: 2,
    });
    // Mark and name together, centred as one unit. Drawn with pdfkit
    // primitives rather than an embedded image: the same 32-unit geometry as
    // the SVG mark, scaled to the receipt.
    const markSize = 5;
    const label = "menu.irad.solutions";
    doc.font("Helvetica").fontSize(6);
    const labelWidth = doc.widthOfString(label);
    const groupLeft = PAD + (INNER - (markSize + 2 + labelWidth)) / 2;

    drawMark(doc, groupLeft, y, markSize);
    doc.fillColor("#1C1C1E").opacity(0.55);
    doc.text(label, groupLeft + markSize + 2, y + 0.6);
    doc.opacity(1).fillColor("#000000");

    doc.end();
  });
}

/**
 * The mark, in pdfkit primitives.
 *
 * Not an embedded PNG: a receipt is often printed on a thermal printer where a
 * raster of this size turns to mush, and the shapes are simple enough that
 * drawing them keeps the edges crisp at any resolution.
 */
function drawMark(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  size: number,
): void {
  const u = size / 32;

  doc.save();
  doc.fillColor("#1C1C1E").opacity(0.55);
  doc.roundedRect(x, y, size, size, 8 * u).fill();

  doc.fillColor("#FFFFFF").opacity(1);
  // Finder ring, drawn as a stroked rounded rect.
  doc
    .lineWidth(2.5 * u)
    .strokeColor("#FFFFFF")
    .roundedRect(x + 6.25 * u, y + 6.25 * u, 12.5 * u, 12.5 * u, 3.75 * u)
    .stroke();
  doc.roundedRect(x + 10.5 * u, y + 10.5 * u, 4 * u, 4 * u, 1.25 * u).fill();
  doc.roundedRect(x + 20.5 * u, y + 20.5 * u, 6 * u, 6 * u, 2 * u).fill();
  doc.restore();
}
