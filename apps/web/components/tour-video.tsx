"use client";

import { useRef, useState } from "react";
import { TOUR } from "@/lib/site";
import { TOUR_TRANSCRIPT } from "@/lib/tour-transcript";

/**
 * The product tour, shared by the landing page and the dashboard's Tutorial
 * page so both always play the same file.
 *
 * `preload="none"` with a poster: the video is ten megabytes and most
 * visitors never press play, so nothing is fetched until someone does. The
 * file is encoded with `faststart`, so playback begins before it has fully
 * downloaded.
 *
 * Subtitles are burned into the video, so there is no captions track — it
 * would show every line twice. The transcript underneath serves anyone who
 * would rather read, and screen readers.
 */
export function TourVideo({
  playLabel,
  transcriptLabel,
  tone = "dark",
}: {
  playLabel: string;
  transcriptLabel: string;
  tone?: "dark" | "app";
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  function play() {
    const v = ref.current;
    if (!v) return;
    setStarted(true);
    void v.play().catch(() => undefined);
    v.focus();
  }

  function seek(at: number) {
    const v = ref.current;
    if (!v) return;
    setStarted(true);
    v.currentTime = at;
    void v.play().catch(() => undefined);
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const dark = tone === "dark";

  return (
    <div>
      <div
        className={[
          "relative aspect-video w-full overflow-hidden rounded-[20px] bg-black",
          dark
            ? "border border-[var(--lp-line)] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]"
            : "border border-line shadow-lift",
        ].join(" ")}
      >
        <video
          ref={ref}
          className="h-full w-full"
          src={TOUR.src}
          poster={TOUR.poster}
          preload="none"
          playsInline
          controls={started}
          onPlay={() => setStarted(true)}
        />
        {!started && (
          <button
            type="button"
            onClick={play}
            className="group absolute inset-0 flex items-end justify-start bg-gradient-to-t from-black/50 via-transparent to-transparent p-3 transition-colors sm:p-6"
          >
            <span
              className={[
                "flex items-center gap-3 rounded-full py-2 pl-2 pr-5 text-[14px] font-semibold sm:py-3 sm:pl-3 sm:pr-6 sm:text-[15px] shadow-[0_16px_40px_-12px_rgba(0,0,0,0.8)] transition-transform group-hover:scale-[1.03]",
                dark ? "bg-[var(--lp-amber)] text-[var(--lp-on-amber)]" : "bg-[var(--accent)] text-white",
              ].join(" ")}
            >
              <span className="grid h-9 w-9 place-items-center rounded-full bg-black/15">
                <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true">
                  <path d="M1 1.8v12.4a1 1 0 0 0 1.52.85l10-6.2a1 1 0 0 0 0-1.7l-10-6.2A1 1 0 0 0 1 1.8Z" />
                </svg>
              </span>
              {playLabel}
              <span className="font-normal opacity-70">{TOUR.label}</span>
            </span>
          </button>
        )}
      </div>

      <details className={["group mt-5", dark ? "" : "text-ink"].join(" ")}>
        <summary
          className={[
            "inline-flex cursor-pointer list-none items-center gap-2 py-1 text-[14.5px] font-medium [&::-webkit-details-marker]:hidden",
            dark ? "text-[var(--lp-muted)] hover:text-[var(--lp-text)]" : "text-muted hover:text-ink",
          ].join(" ")}
        >
          <svg className="transition-transform duration-200 group-open:rotate-45" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {transcriptLabel}
        </summary>
        <ol
          lang="hi-Latn"
          className={[
            "mt-4 max-h-[360px] space-y-2 overflow-y-auto pr-2 text-[14.5px] leading-relaxed",
            dark ? "text-[var(--lp-muted)]" : "text-muted",
          ].join(" ")}
          data-lenis-prevent
        >
          {TOUR_TRANSCRIPT.map((line) => (
            <li key={line.at} className="flex gap-4">
              <button
                type="button"
                onClick={() => seek(line.at)}
                className={[
                  "w-10 shrink-0 text-left tabular-nums",
                  dark ? "text-[var(--lp-faint)] hover:text-[var(--lp-amber)]" : "text-faint hover:text-[var(--accent)]",
                ].join(" ")}
              >
                {Math.floor(line.at / 60)}:{String(line.at % 60).padStart(2, "0")}
              </button>
              <span>{line.text}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
