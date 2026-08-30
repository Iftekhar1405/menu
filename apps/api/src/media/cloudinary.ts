import { createHash } from "node:crypto";
import type { Env } from "../config/env";

/**
 * Cloudinary, spoken to directly.
 *
 * It slots in beside the Supabase and local-disk drivers rather than replacing
 * them, and keeps the property that matters about all three: image bytes never
 * pass through our API. The browser uploads straight to Cloudinary using a
 * signature we mint, so a 4MB photo on restaurant wifi is not something we pay
 * for twice or hold a request open for.
 *
 * The one thing Cloudinary gives us that the others do not is delivery-time
 * transformation, which is why `deliveryUrl` asks for f_auto,q_auto — the same
 * upload is then served as AVIF or WebP at a sensible quality depending on
 * what the diner's phone actually supports.
 */

export function usesCloudinary(env: Env): boolean {
  return Boolean(
    env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
  );
}

export interface CloudinaryTicket {
  uploadUrl: string;
  /** Multipart form fields the browser must send alongside the file. */
  fields: Record<string, string>;
  /** The public_id we chose, stored as the item's path. */
  publicId: string;
}

/**
 * Signs an upload for one specific public_id.
 *
 * The signature covers the public_id, so a client cannot take a ticket for its
 * own folder and write somewhere else with it — the same guarantee the Supabase
 * and local drivers get from the path being composed server-side.
 */
export function signUpload(env: Env, publicId: string): CloudinaryTicket {
  const timestamp = Math.floor(Date.now() / 1000);

  // Cloudinary signs the alphabetically sorted, &-joined parameter list with
  // the API secret appended. Only the parameters below are sent.
  const params: Record<string, string> = {
    public_id: publicId,
    timestamp: String(timestamp),
    // Overwriting is refused: a public_id is minted fresh per upload, so a
    // request to overwrite one is a request to replace someone else's image.
    overwrite: "false",
  };

  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");

  const signature = createHash("sha1")
    .update(toSign + env.CLOUDINARY_API_SECRET)
    .digest("hex");

  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    fields: { ...params, api_key: env.CLOUDINARY_API_KEY, signature },
    publicId,
  };
}

/**
 * The URL an <img> loads. `f_auto,q_auto` lets Cloudinary pick the format and
 * quality per request, which is most of the benefit of using it at all.
 */
export function deliveryUrl(env: Env, publicId: string): string {
  return `https://res.cloudinary.com/${env.CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto/${publicId}`;
}
