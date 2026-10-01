"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import type { Summary } from "@/lib/types";
import { useSession } from "@/components/session";
import { Button, Empty } from "@/components/ui";
import { CopyLink } from "@/components/copy-link";

interface Ratings {
  average: number | null;
  count: number;
  ratings: { id: string; stars: number; privateFeedback: string | null; createdAt: string }[];
}

export default function DashboardPage() {
  const { current } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [ratings, setRatings] = useState<Ratings | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!current) return;
    void api.get<Summary>(`/businesses/${current.id}/summary`).then(setSummary);
    void api.get<Ratings>(`/businesses/${current.id}/ratings`).then(setRatings).catch(() => undefined);
  }, [current]);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 40);
    return () => clearTimeout(t);
  }, []);

  if (!current) return null;

  const menuUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/m/${current.publicCode}`;
  const empty = summary?.items === 0;

  return (
    <div
      className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transition: "opacity 320ms ease, transform 320ms cubic-bezier(0.22,1,0.36,1)",
      }}
    >
      {/* Header */}
      <header className="mb-9">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
              {current.name}
            </h1>
            <p className="mt-1 text-[14.5px] text-muted">
              {empty
                ? "Add your first dish and your menu goes live."
                : "Your menu is live. Changes appear within a few seconds."}
            </p>
          </div>
          {!empty && (
            <span className="mt-1 shrink-0 inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[12px] font-semibold text-[var(--accent-strong)]">
              <span
                className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                style={{ animation: "pulse-glow 2.4s ease-in-out infinite" }}
              />
              Live
            </span>
          )}
        </div>
      </header>

      {empty ? (
        <Empty
          title="No dishes yet"
          body="Start with one category and one item. You can add photos and details later."
          action={
            <Link href="/menu">
              <Button variant="primary">Build the menu</Button>
            </Link>
          }
        />
      ) : (
        <>
          {/* Stats grid */}
          <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Dishes" value={summary?.items} icon="🍽️" delay={0} />
            <Stat label="Sections" value={summary?.categories} icon="📂" delay={60} />
            <Stat label="Views, 7 days" value={summary?.views7} icon="👁️" delay={120} />
            <Stat label="Views, 30 days" value={summary?.views30} icon="📈" delay={180} />
          </section>

          {/* Missing photos nudge */}
          {summary && summary.itemsMissingPhotos > 0 && (
            <section
              className="mb-8 rounded-2xl border border-[var(--accent-soft)] bg-[var(--accent-soft)] p-5"
              style={{ animation: "float-up 280ms cubic-bezier(0.22,1,0.36,1) 240ms both" }}
            >
              <div className="flex items-start gap-4">
                <span className="mt-0.5 text-2xl" aria-hidden="true">📸</span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[15px] font-semibold text-[var(--accent-strong)]">
                    {summary.itemsMissingPhotos} dish{summary.itemsMissingPhotos === 1 ? "" : "es"} without a photo
                  </h2>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--accent-strong)] opacity-80">
                    Dishes with a photo get ordered more often. The Editorial and Grid designs are built around them.
                  </p>
                  <Link href="/menu" className="mt-3 inline-block">
                    <Button size="sm" variant="primary">Add photos</Button>
                  </Link>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/* Menu link card */}
      <section className="rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[var(--accent)] text-lg" aria-hidden="true">🔗</span>
          <h2 className="font-display text-[15px] font-semibold">Your menu link</h2>
        </div>
        <p className="text-[13.5px] text-muted">
          This address never changes, so printed codes keep working.
        </p>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <CopyLink url={menuUrl} />
          <a href={`/m/${current.publicCode}`} target="_blank" rel="noreferrer">
            <Button size="sm">Open menu</Button>
          </a>
          <Link href="/qr">
            <Button size="sm">Get the QR code</Button>
          </Link>
        </div>
      </section>

      {/* Ratings */}
      {ratings && ratings.count > 0 && (
        <section
          className="mt-8 rounded-2xl border border-line bg-surface p-5"
          style={{ animation: "float-up 280ms cubic-bezier(0.22,1,0.36,1) 200ms both" }}
        >
          <header className="flex items-baseline justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <span className="text-lg" aria-hidden="true">⭐</span>
              <h2 className="font-display text-[15px] font-semibold">What diners said</h2>
            </div>
            <span className="tnum text-[13px] text-muted">
              {ratings.average} avg · {ratings.count} in 30 days
            </span>
          </header>

          <ul className="space-y-2.5">
            {ratings.ratings.slice(0, 6).map((rating) => (
              <li key={rating.id} className="flex items-start gap-3">
                <StarBadge stars={rating.stars} />
                <span className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-muted">
                  {rating.privateFeedback ?? (
                    <span className="text-faint italic">No note left</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  delay,
}: {
  label: string;
  value?: number;
  icon: string;
  delay: number;
}) {
  return (
    <div
      className="spring rounded-2xl border border-line bg-surface px-4 py-4 hover:border-[var(--accent-soft)] hover:shadow-lift"
      style={{ animation: `float-up 280ms cubic-bezier(0.22,1,0.36,1) ${delay}ms both` }}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xl leading-none" aria-hidden="true">{icon}</span>
      </div>
      <p className="tnum text-[26px] font-semibold leading-none tracking-tight text-ink">
        {value ?? <span className="skeleton inline-block h-7 w-12">&nbsp;</span>}
      </p>
      <p className="mt-1.5 text-[12.5px] text-muted">{label}</p>
    </div>
  );
}

function StarBadge({ stars }: { stars: number }) {
  return (
    <span
      className="tnum shrink-0 rounded-lg bg-[var(--accent-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--accent-strong)]"
      aria-label={`${stars} out of 5`}
    >
      {stars}★
    </span>
  );
}


interface Ratings {
  average: number | null;
  count: number;
}