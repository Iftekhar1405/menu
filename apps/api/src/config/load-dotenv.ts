import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Environment lives in a single .env at the repo root rather than one per
 * app, so the API and the web app cannot drift onto different databases or
 * secrets. Imported for its side effect before anything reads process.env.
 */
const candidates = [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(__dirname, "../../../../.env"),
];

for (const path of candidates) {
  if (existsSync(path)) {
    config({ path });
    break;
  }
}
