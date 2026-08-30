import type { UploadTicket } from "./types";

/**
 * Sends the bytes wherever the ticket points.
 *
 * Cloudinary wants a multipart POST carrying the signature fields it issued;
 * Supabase and the local driver take a plain PUT. Keeping that difference in
 * one place means the photo uploader and the logo uploader cannot drift apart,
 * and adding a fourth driver is a branch here rather than in every caller.
 */
export async function uploadToTicket(ticket: UploadTicket, blob: Blob): Promise<void> {
  if (ticket.driver === "cloudinary") {
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields ?? {})) {
      form.append(key, value);
    }
    // Appended last: Cloudinary reads the signature fields before the payload.
    form.append("file", blob);

    const res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Cloudinary rejected the upload (${res.status})`);
    return;
  }

  const res = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/webp" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}
