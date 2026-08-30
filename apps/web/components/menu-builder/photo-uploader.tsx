"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { isImage, prepareImage } from "@/lib/image";
import { mediaUrl } from "@/lib/preview";
import { uploadToTicket } from "@/lib/upload";
import type { Photo, UploadTicket } from "@/lib/types";
import { Button, cx } from "../ui";
import { useConfirm } from "../confirm";

/**
 * Photos are resized and converted to WebP in the browser, then uploaded
 * straight to storage with a short-lived signed URL. The original 5MB phone
 * photo never leaves the device and never passes through our API.
 *
 * The first photo is the one diners see on a card, so it is labelled rather
 * than left implicit — otherwise reordering feels arbitrary.
 */
export function PhotoUploader({
  businessId,
  itemId,
  photos,
  onChange,
}: {
  businessId: string;
  itemId: string;
  photos: Photo[];
  onChange: (photos: Photo[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);

    try {
      const added: Photo[] = [];
      for (const file of Array.from(files).slice(0, 10 - photos.length)) {
        if (!isImage(file)) continue;

        const blob = await prepareImage(file);
        const ticket = await api.post<UploadTicket>("/media/upload-url", {
          businessId,
          itemId,
        });

        await uploadToTicket(ticket, blob);

        added.push({
          id: crypto.randomUUID(),
          storagePath: ticket.path,
          alt: null,
          position: photos.length + added.length,
        });
      }
      onChange([...photos, ...added]);
    } catch {
      setError("That photo didn't upload. Try again.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function move(index: number, delta: number) {
    const next = [...photos];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next.map((p, i) => ({ ...p, position: i })));
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">Photos</span>
        <span className="text-[12px] text-faint">{photos.length} of 10</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {photos.map((photo, i) => (
          <figure
            key={photo.id}
            className="group relative h-[84px] w-[84px] overflow-hidden rounded-xl border border-line bg-raised"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={mediaUrl(photo.storagePath)}
              alt=""
              className="h-full w-full object-cover"
            />
            {i === 0 && (
              <figcaption className="absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-medium text-white">
                Shown first
              </figcaption>
            )}
            <div className="spring absolute inset-x-0 top-0 flex justify-between opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label="Move photo earlier"
                className="h-6 w-6 bg-black/55 text-[13px] text-white disabled:opacity-30"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Remove this photo?",
                    body:
                      i === 0 && photos.length > 1
                        ? "It is the first photo, so the next one becomes the one diners see."
                        : "It comes off the dish once you save.",
                    confirmLabel: "Remove photo",
                  });
                  if (ok) onChange(photos.filter((p) => p.id !== photo.id));
                }}
                aria-label="Remove photo"
                className="h-6 w-6 bg-black/55 text-[13px] text-white"
              >
                ×
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === photos.length - 1}
                aria-label="Move photo later"
                className="h-6 w-6 bg-black/55 text-[13px] text-white disabled:opacity-30"
              >
                ›
              </button>
            </div>
          </figure>
        ))}

        {photos.length < 10 && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className={cx(
              "spring flex h-[84px] w-[84px] flex-col items-center justify-center gap-1",
              "rounded-xl border border-dashed border-line text-[12px] text-muted",
              "hover:border-[var(--accent)] hover:text-[var(--accent)]",
            )}
          >
            <span className="text-[18px] leading-none">+</span>
            {busy ? "Uploading" : "Add"}
          </button>
        )}
      </div>

      {error && <p className="mt-1.5 text-[12.5px] text-[#B3261E]">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => void addFiles(e.target.files)}
      />
    </div>
  );
}
