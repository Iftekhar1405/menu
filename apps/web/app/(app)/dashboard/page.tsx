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

  useEffect(() => {
    if (!current) return;
    void api.get<Summary>(`/businesses/${current.id}/summary`).then(setSummary);
    void api.get<Ratings>(`/businesses/${current.id}/ratings`).then(setRatings).catch(() => undefined);
  }, [current]);

  if (!current) return null;

  const menuUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/m/${current.publicCode}`;
  const empty = summary?.items === 0;

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10 lg:py-12">
      <header className="mb-9">
        <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
          {current.name}
        </h1>
        <p className="mt-1 text-[14.5px] text-muted">
          {empty
            ? "Add your first dish and your menu goes live."
            : "Your menu is live. Changes appear within a few seconds."}
        </p>
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
          <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Dishes" value={summary?.items} />
            <Stat label="Sections" value={summary?.categories} />
            <Stat label="Views, 7 days" value={summary?.views7} />
            <Stat label="Views, 30 days" value={summary?.views30} />
          </section>

          {summary && summary.itemsMissingPhotos > 0 && (
            <section className="mb-8 rounded-2xl border border-line bg-surface p-5">
              <h2 className="font-display text-[15px] font-semibold">
                {summary.itemsMissingPhotos} dish
                {summary.itemsMissingPhotos === 1 ? "" : "es"} without a photo
              </h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
                Dishes with a photo get ordered more often. The Editorial and Grid
                designs are built around them.
              </p>
              <Link href="/menu" className="mt-3 inline-block">
                <Button size="sm">Add photos</Button>
              </Link>
            </section>
          )}
        </>
      )}

      <section className="rounded-2xl border border-line bg-surface p-5">
        <h2 className="font-display text-[15px] font-semibold">Your menu link</h2>
        <p className="mt-1 text-[13.5px] text-muted">
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

      {ratings && ratings.count > 0 && (
        <section className="mt-8 rounded-2xl border border-line bg-surface p-5">
          <header className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[15px] font-semibold">
              What diners said
            </h2>
            <span className="tnum text-[13px] text-muted">
              {ratings.average} average · {ratings.count} in 30 days
            </span>
          </header>

          <ul className="mt-3.5 space-y-2.5">
            {ratings.ratings.slice(0, 6).map((rating) => (
              <li key={rating.id} className="flex items-start gap-3">
                <span
                  className="tnum shrink-0 rounded-lg bg-[var(--accent-soft)] px-2 py-0.5 text-[13px] font-semibold text-[var(--accent-strong)]"
                  aria-label={`${rating.stars} out of 5`}
                >
                  {rating.stars}★
                </span>
                <span className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-muted">
                  {/* Private feedback is meant for the owner and is never
                      published anywhere the diner can see. */}
                  {rating.privateFeedback ?? (
                    <span className="text-faint">No note left</span>
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

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-4 py-3.5">
      <p className="tnum text-[26px] font-semibold leading-none tracking-tight">
        {value ?? "—"}
      </p>
      <p className="mt-1.5 text-[12.5px] text-muted">{label}</p>
    </div>
  );
}
