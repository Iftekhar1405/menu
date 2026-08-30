import { Injectable, Logger } from "@nestjs/common";
import { loadEnv } from "../config/env";

/**
 * Tells Next to rebuild one public menu page.
 *
 * The public menu is statically rendered so a scan comes off the edge cache
 * rather than the database. That only works if a save pushes the new version
 * out immediately, which is what this does — one path, not a global purge.
 *
 * Failure is logged, never thrown. An owner editing a dish should not see
 * their save fail because the frontend was briefly unreachable; the page
 * catches up on its next natural revalidation.
 */
@Injectable()
export class RevalidateClient {
  private readonly logger = new Logger(RevalidateClient.name);
  private readonly env = loadEnv();

  async menu(publicCode: string): Promise<void> {
    const url = `${this.env.WEB_ORIGIN}/api/revalidate`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-revalidate-secret": this.env.REVALIDATE_SECRET,
        },
        body: JSON.stringify({ path: `/m/${publicCode}` }),
      });
      if (!res.ok) {
        this.logger.warn(`Revalidate for ${publicCode} returned ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(`Revalidate for ${publicCode} failed: ${String(err)}`);
    }
  }
}
