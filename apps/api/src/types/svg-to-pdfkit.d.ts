declare module "svg-to-pdfkit" {
  import type PDFDocument from "pdfkit";

  interface SVGtoPDFOptions {
    width?: number;
    height?: number;
    preserveAspectRatio?: string;
    /** When false, lengths with units (mm) are converted rather than treated as pt. */
    assumePt?: boolean;
    useCSS?: boolean;
    fontCallback?: (family: string, bold: boolean, italic: boolean) => string;
  }

  export default function SVGtoPDF(
    doc: typeof PDFDocument.prototype,
    svg: string,
    x?: number,
    y?: number,
    options?: SVGtoPDFOptions,
  ): void;
}
