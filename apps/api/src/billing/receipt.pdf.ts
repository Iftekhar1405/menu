import PDFDocument from "pdfkit";
import type { Bill } from "./billing.service";
import { drawCredit, drawLogo, money as fmtMoney } from "./pdf-brand";

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

export function buildReceiptPdf(bill: Bill, logo: Buffer | null): Promise<Buffer> {
  // Height is estimated generously and the page is not reflowed: pdfkit needs
  // a size up front, and a little extra whitespace at the foot of a receipt
  // costs nothing.
  const height =
    (130 + bill.lines.length * 14 + (bill.receiptFooter ? 30 : 0) + (logo ? 20 : 0)) * MM;

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

    const money = (v: string) => fmtMoney(v, bill.currency);

    // ── Header ──
    // The owner's logo, centred above their name. Stored as PNG so pdfkit can
    // actually embed it.
    if (logo) {
      const size = 14 * MM;
      if (drawLogo(doc, logo, PAD + (INNER - size) / 2, y, size)) {
        y += size + 2 * MM;
      }
    }

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
    drawCredit(doc, PAD, INNER, y, 6);

    doc.end();
  });
}
