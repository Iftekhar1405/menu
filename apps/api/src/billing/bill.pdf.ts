import PDFDocument from "pdfkit";
import type { Bill } from "./billing.service";
import { drawCredit, drawLogo, money } from "./pdf-brand";

/**
 * The bill: A5, laid out as a document rather than a till slip.
 *
 * This is the one a diner emails to themselves or hands to an accounts
 * department, so it is a page with a header, a proper item table with a tax
 * column, and a totals block — not an 80mm strip. The receipt
 * (receipt.pdf.ts) stays for the counter printer; the two are different
 * artefacts for different moments, which is why they are separate files
 * rather than one function with a flag.
 *
 * Both carry the business's own logo. Same disclaimer on both: this shows tax
 * but is not a GST tax invoice.
 */
const MM = 2.8346;
const W = 148 * MM;
const H = 210 * MM;
const M = 14 * MM;
const INNER = W - M * 2;

const INK = "#1C1C1E";
const MUTED = "#6B6F78";
const LINE = "#E3E5E8";

export function buildBillPdf(bill: Bill, logo: Buffer | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [W, H], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const b = bill.business;
    let y = M;

    /* ── Header ────────────────────────────────────────────────────────────
     * Logo left, business identity beside it, document meta right. The
     * business is the subject of this page, so it gets the visual weight and
     * our own mark stays at the foot. */
    const logoSize = 13 * MM;
    const hasLogo = drawLogo(doc, logo, M, y, logoSize);
    const textLeft = hasLogo ? M + logoSize + 4 * MM : M;
    const metaWidth = 42 * MM;
    const nameWidth = W - M - textLeft - metaWidth - 4 * MM;

    doc.fillColor(INK).font("Helvetica-Bold").fontSize(15);
    doc.text(b.name, textLeft, y + 1, { width: nameWidth });
    let leftY = doc.y;

    const address = [
      b.addressLine1,
      b.addressLine2,
      [b.city, b.state].filter(Boolean).join(", "),
      b.postalCode,
    ]
      .filter(Boolean)
      .join("\n");

    if (address) {
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      doc.text(address, textLeft, leftY + 1.5, { width: nameWidth });
      leftY = doc.y;
    }
    if (b.gstin) {
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      doc.text(`GSTIN ${b.gstin}`, textLeft, leftY + 1, { width: nameWidth });
      leftY = doc.y;
    }

    // Meta block, right aligned.
    const metaLeft = W - M - metaWidth;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK);
    doc.text("BILL", metaLeft, y + 2, { width: metaWidth, align: "right" });
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
    doc.text(`No. ${bill.billNumber}`, metaLeft, doc.y + 1, {
      width: metaWidth,
      align: "right",
    });
    doc.text(`Table ${bill.tableLabel}`, metaLeft, doc.y, {
      width: metaWidth,
      align: "right",
    });
    doc.text(
      new Date(bill.issuedAt).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }),
      metaLeft,
      doc.y,
      { width: metaWidth, align: "right" },
    );

    y = Math.max(leftY, doc.y, M + logoSize) + 6 * MM;

    /* ── Item table ─────────────────────────────────────────────────────── */
    const showTax = Number(bill.taxTotal) > 0;
    // Columns from the right so the money columns line up regardless of how
    // long a dish name runs.
    const cAmount = W - M - 22 * MM;
    const cTax = showTax ? cAmount - 16 * MM : cAmount;
    const cRate = cTax - 18 * MM;
    const cQty = cRate - 10 * MM;
    const nameW = cQty - M - 3 * MM;

    const headerRow = () => {
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED);
      doc.text("ITEM", M, y, { width: nameW, lineBreak: false });
      doc.text("QTY", cQty, y, { width: 10 * MM, align: "right", lineBreak: false });
      doc.text("RATE", cRate, y, { width: 18 * MM, align: "right", lineBreak: false });
      if (showTax) {
        doc.text(bill.taxLabel.toUpperCase(), cTax, y, {
          width: 16 * MM,
          align: "right",
          lineBreak: false,
        });
      }
      doc.text("AMOUNT", cAmount, y, {
        width: 22 * MM,
        align: "right",
        lineBreak: false,
      });
      y += 4.5 * MM;
      rule();
    };

    const rule = (colour = LINE) => {
      doc
        .moveTo(M, y)
        .lineTo(W - M, y)
        .lineWidth(0.6)
        .strokeColor(colour)
        .stroke();
      y += 2.5 * MM;
    };

    headerRow();

    for (const item of bill.lines) {
      const label = item.variant ? `${item.name} (${item.variant})` : item.name;

      doc.font("Helvetica").fontSize(9).fillColor(INK);
      doc.text(label, M, y, { width: nameW });
      const rowBottom = doc.y;

      doc.text(String(item.quantity), cQty, y, { width: 10 * MM, align: "right" });
      doc.text(money(item.unitPrice, bill.currency), cRate, y, {
        width: 18 * MM,
        align: "right",
      });
      if (showTax) {
        doc.fillColor(MUTED).fontSize(8);
        doc.text(`${Number(item.taxRate)}%`, cTax, y + 0.5, {
          width: 16 * MM,
          align: "right",
        });
        doc.fillColor(INK).fontSize(9);
      }
      doc.text(money(item.lineTotal, bill.currency), cAmount, y, {
        width: 22 * MM,
        align: "right",
      });

      y = Math.max(rowBottom, doc.y) + 2 * MM;
    }

    y += 1 * MM;
    rule();

    /* ── Totals ─────────────────────────────────────────────────────────── */
    const totalsLeft = cRate - 12 * MM;
    const labelW = 34 * MM;
    const valueW = W - M - (totalsLeft + labelW);

    const totalRow = (label: string, value: string, bold = false, size = 9) => {
      doc
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(size)
        .fillColor(bold ? INK : MUTED);
      doc.text(label, totalsLeft, y, { width: labelW, lineBreak: false });
      doc.fillColor(INK);
      doc.text(value, totalsLeft + labelW, y, {
        width: valueW,
        align: "right",
        lineBreak: false,
      });
      y += (bold ? 6 : 5) * MM;
    };

    totalRow(
      bill.pricesIncludeTax ? "Subtotal (before tax)" : "Subtotal",
      money(bill.subtotal, bill.currency),
    );
    if (showTax) totalRow(bill.taxLabel, money(bill.taxTotal, bill.currency));
    if (Number(bill.serviceCharge) > 0) {
      totalRow(
        `Service charge (${Number(bill.serviceChargeRate)}%)`,
        money(bill.serviceCharge, bill.currency),
      );
    }
    if (Number(bill.roundOff) !== 0) {
      totalRow("Rounding", money(bill.roundOff, bill.currency));
    }

    y += 1 * MM;
    rule("#C9CDD2");
    totalRow("TOTAL", money(bill.total, bill.currency), true, 12);

    /* ── Footer ─────────────────────────────────────────────────────────── */
    // Pinned to the bottom rather than following the totals, so a two-line
    // bill and a twenty-line bill both look like the same document.
    let f = H - M - 20 * MM;

    if (Number(bill.serviceCharge) > 0) {
      doc.font("Helvetica").fontSize(7).fillColor(MUTED);
      doc.text(
        "Service charge is optional and can be removed on request.",
        M,
        f,
        { width: INNER, align: "center" },
      );
      f = doc.y + 1.5 * MM;
    }

    if (bill.receiptFooter) {
      doc.font("Helvetica").fontSize(8.5).fillColor(INK);
      doc.text(bill.receiptFooter, M, f, { width: INNER, align: "center" });
      f = doc.y + 2 * MM;
    }

    // Said on the document itself rather than left for a GST-registered
    // business to discover from a customer.
    doc.font("Helvetica").fontSize(7).fillColor(MUTED);
    doc.text("This is a receipt, not a GST tax invoice.", M, f, {
      width: INNER,
      align: "center",
    });

    drawCredit(doc, M, INNER, doc.y + 2 * MM, 6.5);

    doc.end();
  });
}
