"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api-client";
import { guessCountryClient } from "@/lib/country";
import { useSession } from "@/components/session";
import { useConfirm } from "@/components/confirm";
import { IdentifierField } from "@/components/identifier-field";
import { Banner, Button, Empty, Field, Input } from "@/components/ui";

/**
 * A kitchen login as the owner sees it: enough to tell who it is, how to
 * reach them, and whether they're still using the PIN the owner chose for
 * them. Never a price, a bill, or anything else this role can't see.
 */
interface Staff {
  id: string;
  status: "active" | "suspended";
  user: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    mustChangePin: boolean;
  };
}

export default function StaffPage() {
  const { current } = useSession();
  const confirm = useConfirm();

  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [country, setCountry] = useState("IN");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  /**
   * The only time anyone but the staff member will ever see this PIN — the
   * server stores just an argon2 hash from here on. Held in memory only
   * (never logged, never in a URL, never persisted) and cleared the moment
   * the owner dismisses it.
   */
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Staff ids with a mutation in flight. Row-scoped (a `Set`, same pattern as
   * `/dishes`'s `pending`) rather than one page-wide flag: suspending one
   * person must not freeze the Remove button on everyone else's row, and the
   * dimmed styling below is keyed off membership in this set, so the gate and
   * the visual always agree about which rows are actually busy.
   */
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  useEffect(() => setCountry(guessCountryClient()), []);

  const load = useCallback(async () => {
    if (!current) return;
    setLoadError(null);
    try {
      setStaff(await api.get<Staff[]>(`/businesses/${current.id}/staff`));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "We couldn't load your staff just now.");
    }
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!current || creating) return;
    setCreating(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await api.post<{ staff: Staff; pin: string }>(
        `/businesses/${current.id}/staff`,
        { fullName, identifier, country },
      );
      setIssued({ name: res.staff.user.fullName, pin: res.pin });
      setCopied(false);
      setFullName("");
      setIdentifier("");
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        // Verbatim: the API deliberately reuses signup's own wording for a
        // taken identifier so this form can't be used to probe who has an
        // account. Rewriting it here would defeat that.
        setError(err.message);
        setFieldErrors(err.fieldErrors ?? {});
      } else {
        setError("Could not create that login. Try again.");
      }
    } finally {
      setCreating(false);
    }
  }

  /** Adds `id` to the busy set — called before every mutation below. */
  function markBusy(id: string) {
    setBusyIds((prev) => new Set(prev).add(id));
  }

  /**
   * Removes `id` from the busy set. Called from `finally` in every mutator,
   * not just the error path — this was the exact bug that shipped once: a
   * row left in the busy set after a *successful* removal reads as "still
   * working" forever, because nothing else ever clears it. Both the happy
   * path and the error path must end here.
   */
  function clearBusy(id: string) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function setStatus(row: Staff, status: "active" | "suspended") {
    if (!current || busyIds.has(row.id)) return;
    if (status === "suspended") {
      const ok = await confirm({
        title: `Suspend ${row.user.fullName}?`,
        body: "They're signed out immediately and can't sign back in until you reactivate them.",
        confirmLabel: "Suspend",
        tone: "normal",
      });
      if (!ok) return;
    }
    markBusy(row.id);
    setError(null);
    try {
      await api.patch(`/businesses/${current.id}/staff/${row.id}`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      clearBusy(row.id);
    }
  }

  async function resetPin(row: Staff) {
    if (!current || busyIds.has(row.id)) return;
    markBusy(row.id);
    setError(null);
    try {
      const res = await api.post<{ pin: string }>(
        `/businesses/${current.id}/staff/${row.id}/reset-pin`,
        {},
      );
      setIssued({ name: row.user.fullName, pin: res.pin });
      setCopied(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset their PIN. Try again.");
    } finally {
      clearBusy(row.id);
    }
  }

  async function remove(row: Staff) {
    if (!current || busyIds.has(row.id)) return;
    const ok = await confirm({
      title: `Remove ${row.user.fullName}?`,
      body:
        "This deletes their account entirely, not just their access to this business. They're signed out immediately and can't sign back in. This can't be undone.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    markBusy(row.id);
    setError(null);
    try {
      await api.del(`/businesses/${current.id}/staff/${row.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not remove them. Try again.");
    } finally {
      clearBusy(row.id);
    }
  }

  async function copyPin(pin: string) {
    try {
      await navigator.clipboard.writeText(pin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Insecure origin or no permission — the PIN is already on screen in
      // large type, so there's nothing more useful to do than leave it be.
      setCopied(false);
    }
  }

  if (!current) return null;

  return (
    <div className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">
          Kitchen staff
        </h1>
        <p className="mt-1 text-[14.5px] text-muted">
          Kitchen logins see orders and dishes. They can&apos;t see prices, bills, or
          settings.
        </p>
      </header>

      {issued && (
        <div
          role="status"
          className="mb-6 rounded-2xl border border-[var(--accent-soft)] bg-[var(--accent-soft)] p-5"
        >
          <p className="text-[14px] font-medium text-ink">{issued.name}&apos;s PIN</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <p className="tnum font-mono text-[32px] font-semibold tracking-[0.2em] text-ink">
              {issued.pin}
            </p>
            <Button type="button" size="sm" onClick={() => void copyPin(issued.pin)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Write this down or hand it over now — it won&apos;t be shown again. They&apos;ll
            be asked to choose their own PIN the first time they sign in.
          </p>
          <Button type="button" size="sm" variant="ghost" className="mt-3" onClick={() => setIssued(null)}>
            Done
          </Button>
        </div>
      )}

      {error && (
        <div className="mb-6">
          <Banner>{error}</Banner>
        </div>
      )}

      <form onSubmit={add} className="space-y-4 rounded-2xl border border-line bg-surface p-5">
        <h2 className="font-display text-[15px] font-semibold text-ink">Add a kitchen login</h2>
        <Field label="Name" error={fieldErrors.fullName}>
          <Input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            autoComplete="name"
            placeholder="Ravi Kumar"
            required
          />
        </Field>
        <IdentifierField
          value={identifier}
          onChange={setIdentifier}
          country={country}
          onCountryChange={setCountry}
          error={fieldErrors.identifier}
        />
        <Button type="submit" variant="primary" loading={creating}>
          Add kitchen login
        </Button>
      </form>

      <section className="mt-8">
        {staff === null ? (
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
        ) : staff.length === 0 ? (
          <Empty
            title="No kitchen logins yet"
            body="Add one above to let kitchen staff see orders and dishes without access to prices, bills, or this settings page."
          />
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {staff.map((row) => (
              <li
                key={row.id}
                className={
                  "flex flex-wrap items-center justify-between gap-3 px-4 py-3.5" +
                  (busyIds.has(row.id) ? " pointer-events-none opacity-60" : "")
                }
              >
                <div className="min-w-0">
                  <p className="truncate text-[14.5px] font-medium text-ink">
                    {row.user.fullName}
                  </p>
                  <p className="truncate text-[12.5px] text-faint">
                    {row.user.phone ?? row.user.email}
                    {row.status === "suspended" && " · suspended"}
                    {row.user.mustChangePin && " · hasn't set their own PIN yet"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {row.status === "active" ? (
                    <Button size="sm" onClick={() => void setStatus(row, "suspended")}>
                      Suspend
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => void setStatus(row, "active")}>
                      Reactivate
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void resetPin(row)}>
                    Reset PIN
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(row)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
