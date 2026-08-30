import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv, usesSupabaseStorage } from "../config/env";

export interface UploadTicket {
  /** Where the browser PUTs the bytes. */
  uploadUrl: string;
  /** What to send back to the API once the upload succeeds. */
  path: string;
  /** Local driver only: the API accepts a plain PUT at uploadUrl. */
  driver: "supabase" | "local";
}

/**
 * Issues short-lived, path-scoped upload tickets.
 *
 * Two things matter here. First, image bytes never pass through this API —
 * the browser uploads directly to storage, so we do not pay for the bandwidth
 * twice or hold a request open for a 4MB photo on a hotel wifi. Second, the
 * client never chooses the path: it is built from the business id server-side,
 * which is what stops one tenant writing into another's folder.
 *
 * Without Supabase credentials this falls back to a local disk driver so the
 * whole upload flow works in development.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly env = loadEnv();

  private readonly localRoot = join(process.cwd(), ".uploads");

  async createUploadUrl(
    businessId: string,
    kind: "logo" | "item",
    itemId?: string,
  ): Promise<UploadTicket> {
    if (kind === "item" && !itemId) {
      throw new BadRequestException("An item id is required for item photos");
    }

    // Path is composed here, never taken from the client. The first segment
    // is the tenant boundary that storage policies check.
    const filename = `${randomUUID()}.webp`;
    const path =
      kind === "logo"
        ? `${businessId}/logo/${filename}`
        : `${businessId}/items/${itemId}/${filename}`;

    if (usesSupabaseStorage(this.env)) {
      return { uploadUrl: await this.signSupabaseUpload(path), path, driver: "supabase" };
    }

    // The local driver has no cloud signing service, so the ticket carries an
    // HMAC the upload route verifies. Same property as a cloud signed URL:
    // short-lived, bound to one path, unforgeable by the client.
    const exp = Date.now() + 300_000;
    const token = createHmac("sha256", this.env.REVALIDATE_SECRET)
      .update(`${path}.${exp}`)
      .digest("hex");

    return {
      uploadUrl: `${this.publicApiOrigin()}/media/local/${path}?exp=${exp}&token=${token}`,
      path,
      driver: "local",
    };
  }

  private publicApiOrigin(): string {
    return `http://localhost:${this.env.API_PORT}`;
  }

  private async signSupabaseUpload(path: string): Promise<string> {
    const endpoint = `${this.env.SUPABASE_URL}/storage/v1/object/upload/sign/${this.env.SUPABASE_STORAGE_BUCKET}/${path}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      // Five minutes is plenty for an upload and short enough that a leaked
      // URL is not a standing write grant.
      body: JSON.stringify({ expiresIn: 300 }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "<unreadable>");
      this.logger.error(`Supabase sign failed (${res.status}): ${detail}`);
      throw new Error("Could not prepare the upload");
    }

    const body = (await res.json()) as { url?: string };
    if (!body.url) throw new Error("Supabase returned no signed URL");
    return `${this.env.SUPABASE_URL}/storage/v1${body.url}`;
  }

  /** Local driver: writes bytes the dev server will serve back. */
  async saveLocal(path: string, bytes: Buffer): Promise<void> {
    const full = join(this.localRoot, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, bytes);
  }

  localFilePath(path: string): string {
    return join(this.localRoot, path);
  }

  /** Turns a stored path into something an <img> can load. */
  publicUrl(path: string | null): string | null {
    if (!path) return null;
    if (usesSupabaseStorage(this.env)) {
      return `${this.env.SUPABASE_URL}/storage/v1/object/public/${this.env.SUPABASE_STORAGE_BUCKET}/${path}`;
    }
    return `${this.publicApiOrigin()}/media/local/${path}`;
  }
}
