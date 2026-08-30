const MAX_EDGE = 1600;

/**
 * Resizes and converts a photo to WebP in the browser, before it is uploaded.
 *
 * A phone camera produces 3-6MB JPEGs. Uploading those means slow saves on
 * restaurant wifi, storage cost, and — worst — a diner on mobile data paying
 * to download a 4MB image of a dosa. Doing this client-side means the large
 * original never leaves the device at all.
 */
export async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process this image");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.82),
  );
  if (!blob) throw new Error("Could not process this image");
  return blob;
}

export function isImage(file: File): boolean {
  return /^image\/(jpeg|png|webp|avif|heic|heif)$/i.test(file.type);
}
