import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv, usesSupabaseStorage } from "../config/env";
import { deliveryUrl, signUpload, usesCloudinary } from "./cloudinary";

export interface UploadTicket {
  /** Where the browser sends the bytes. */
  uploadUrl: string;
  /** What to send back to the API once the upload succeeds. */
  path: string;
  driver: "cloudinary" | "supabase" | "local";
  /**
   * Cloudinary only: multipart form fields that must accompany the file.
   * Supabase and the local driver take a plain PUT of the bytes.
   */
  fields?: Record<string, string>;
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

    // Logos are PNG because they are embedded into bills and printed cards,
    // and a PDF cannot carry WebP. Photos stay WebP — they are only ever
    // shown in a browser, where WebP is smaller for the same quality.
    const ext = kind === "logo" ? "png" : "webp";

    // Path is composed here, never taken from the client. The first segment
    // is the tenant boundary that storage policies check.
    const filename = `${randomUUID()}.${ext}`;
    const path =
      kind === "logo"
        ? `${businessId}/logo/${filename}`
        : `${businessId}/items/${itemId}/${filename}`;

    // Cloudinary first when configured: it is the only driver that optimises
    // per-request at delivery, which matters most on the diner's phone.
    if (usesCloudinary(this.env)) {
      // Cloudinary appends its own extension, so the public_id carries none.
      const publicId = path.replace(/\.(webp|png)$/, "");
      const ticket = signUpload(this.env, publicId);
      return {
        uploadUrl: ticket.uploadUrl,
        path: ticket.publicId,
        driver: "cloudinary",
        fields: ticket.fields,
      };
    }

    if (usesSupabaseStorage(this.env)) {
      return { uploadUrl: await this.signSupabaseUpload(path), path, driver: "supabase" };
    }

    // Serverless filesystems are read-only outside /tmp, and /tmp does not
    // survive between invocations — so in production the local driver is not a
    // fallback, it is a misconfiguration. Say so here rather than handing back
    // a ticket pointing at localhost.
    if (this.env.NODE_ENV === "production") {
      throw new Error(
        "No image storage configured: set CLOUDINARY_* (or SUPABASE_*) in production.",
      );
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

  /**
   * The raw bytes of a stored image, for embedding into a PDF or an SVG.
   * Returns null rather than throwing: a missing logo must never stop an
   * owner printing a bill or a QR card.
   */
  async imageBytes(path: string | null): Promise<Buffer | null> {
    if (!path) return null;
    try {
      if (usesCloudinary(this.env) || usesSupabaseStorage(this.env)) {
        const url = this.publicUrl(path);
        if (!url) return null;
        const res = await fetch(url);
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      }
      return await readFile(this.localFilePath(path));
    } catch {
      return null;
    }
  }

  /** Turns a stored path into something an <img> can load. */
  publicUrl(path: string | null): string | null {
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    if (usesCloudinary(this.env)) {
      return deliveryUrl(this.env, path);
    }
    if (usesSupabaseStorage(this.env)) {
      return `${this.env.SUPABASE_URL}/storage/v1/object/public/${this.env.SUPABASE_STORAGE_BUCKET}/${path}`;
    }
    return `${this.publicApiOrigin()}/media/local/${path}`;
  }
}
