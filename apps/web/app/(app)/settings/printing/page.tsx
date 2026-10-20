"use client";

import { useCallback, useEffect, useState } from "react";
import { PRINT_JOBS, type PrintJob } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { Banner, Button, Empty, Input } from "@/components/ui";
import { lastSeenLabel } from "@/lib/station/last-seen";

/**
 * A machine the owner can see, but not operate on, from here. Linking a
 * printer happens on the station itself — a browser can only see the USB
 * and serial devices plugged into the computer it is running on — so this
 * page is deliberately read-only about the devices: rename and revoke are
 * the only writes it offers.
 */
interface Output {
  job: PrintJob;
  deviceLabel: string;
  paperWidth: number;
}
interface Station {
  id: string;
  name: string;
  lastSeenAt: string | null;
  outputs: Output[];
}

const JOB_LABEL: Record<PrintJob, string> = {
  token: "Customer token",
  kitchen: "Kitchen ticket",
  bill: "Bill",
};

export default function PrintingSettingsPage() {
  const { current } = useSession();
  const confirm = useConfirm();

  const [stations, setStations] = useState<Station[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  /**
   * Station ids with a mutation in flight. Row-scoped, same pattern as
   * `/settings/staff`'s `busyIds` — revoking one machine must not freeze the
   * Rename button on every other row.
   */
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!current) return;
    setLoadError(null);
    try {
      setStations(await api.get<Station[]>(`/businesses/${current.id}/stations`));
    } catch (err) {
      setLoadError(
        err instanceof ApiError ? err.message : "We couldn't load your machines just now.",
      );
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  function markBusy(id: string) {
    setBusyIds((prev) => new Set(prev).add(id));
  }

  /** Cleared in `finally`, success or failure alike — see staff page for why. */
  function clearBusy(id: string) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function startRename(station: Station) {
    setRenaming(station.id);
    setDraft(station.name);
  }

  async function saveRename(id: string) {
    if (!current || busyIds.has(id)) return;
    const name = draft.trim();
    if (!name) return;
    markBusy(id);
    setError(null);
    try {
      await api.patch(`/businesses/${current.id}/stations/${id}`, { name });
      setRenaming(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      clearBusy(id);
    }
  }

  async function revoke(station: Station) {
    if (!current || busyIds.has(station.id)) return;
    // Revoking is how a lost or stolen machine stops printing, so it is
    // worth one deliberate confirmation.
    const ok = await confirm({
      title: `Stop ${station.name} printing?`,
      body: "It stops receiving tickets immediately. What it already printed stays on record.",
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    markBusy(station.id);
    setError(null);
    try {
      await api.del(`/businesses/${current.id}/stations/${station.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke that machine. Try again.");
    } finally {
      clearBusy(station.id);
    }
  }

  if (!current) return null;

  return (
    <div className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
          Printing
        </h1>
        <p className="mt-1 text-[14.5px] text-muted">
          A machine becomes a station by opening <code>/station</code> on it and naming it.
          Printers are linked there too — a browser can only see the USB and serial devices
          plugged into the computer it is running on.
        </p>
      </header>

      {error && (
        <div className="mb-6">
          <Banner>{error}</Banner>
        </div>
      )}

      <section>
        {stations === null ? (
          loadError ? (
            <Banner>
              {loadError}{" "}
              <Button size="sm" variant="ghost" className="ml-1" onClick={() => void load()}>
                Try again
              </Button>
            </Banner>
          ) : (
            <p className="text-[14px] text-faint">Loading…</p>
          )
        ) : stations.length === 0 ? (
          <Empty
            title="No machines yet"
            body="Open /station on the shop computer to set the first one up."
          />
        ) : (
          <ul className="space-y-3">
            {stations.map((station) => {
              const busy = busyIds.has(station.id);
              return (
                <li
                  key={station.id}
                  data-testid={`station-${station.id}`}
                  className={
                    "rounded-2xl border border-line bg-surface p-4" +
                    (busy ? " pointer-events-none opacity-60" : "")
                  }
                >
                  <header className="flex items-baseline justify-between gap-3">
                    {renaming === station.id ? (
                      <span className="flex flex-1 items-center gap-2">
                        <Input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          maxLength={40}
                          autoFocus
                        />
                        <Button size="sm" variant="primary" onClick={() => void saveRename(station.id)}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <h2 className="font-display text-[16px] font-semibold text-ink">
                        {station.name}
                      </h2>
                    )}
                    <span
                      className="shrink-0 text-[13px] text-faint"
                      data-testid={`last-seen-${station.id}`}
                    >
                      {lastSeenLabel(station.lastSeenAt)}
                    </span>
                  </header>

                  <ul className="mt-3 space-y-1 text-[13px]">
                    {PRINT_JOBS.map((job) => {
                      const out = station.outputs.find((o) => o.job === job);
                      return (
                        <li key={job} className="flex justify-between">
                          <span className="text-muted">{JOB_LABEL[job]}</span>
                          <span className="text-ink">
                            {out ? `${out.deviceLabel} · ${out.paperWidth}mm` : "—"}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  {renaming !== station.id && (
                    <footer className="mt-3 flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => startRename(station)}>
                        Rename
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void revoke(station)}>
                        Revoke
                      </Button>
                    </footer>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
