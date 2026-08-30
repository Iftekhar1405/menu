// Proves a generated card actually scans: decodes the PNG back to a URL.
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { readFileSync } from "node:fs";

const file = process.argv[2];
const png = PNG.sync.read(readFileSync(file));
const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
console.log("image:", png.width + "x" + png.height);
console.log("decoded:", result ? result.data : "FAILED TO DECODE");
process.exit(result ? 0 : 1);
