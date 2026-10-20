"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PRINT_JOBS, type AccessRole, type PrintJob } from "@menu/shared";
import { ApiError, api } from "@/lib/api-client";
import { useSession } from "@/components/session";
import { Banner, Button, Empty, Field, Input } from "@/components/ui";
import { stationApi } from "@/lib/station/api";
import {
  drain,
  reprintJob,
  type DrainResult,
  type FailedJob,
  type PendingJob,
  type PrinterTransport,
  type StationOutputRef,
} from "@/lib/station/loop";
import { forgetStation, rememberStation, stationIdFor } from "@/lib/station/identity";
import { openChannel, realtimeConfig } from "@/lib/notifications/realtime";
import { deviceKeyOf, serialKeyOf, serialTransport, usbTransport } from "@/lib/station/transport";

type Transport = "usb" | "serial";

interface Output {
  job: PrintJob;
  deviceLabel: string;
  deviceKey: string;
  transport: Transport;
  paperWidth: 58 | 80;
}
interface Station {
  id: string;
  name: string;
  outputs: Output[];
}

/** The ping is an optimisation over this, and is allowed to be lost. */
const POLL_MS = 10_000;

const JOB_LABEL: Record<PrintJob, string> = {
  token: "Customer token",
  kitchen: "Kitchen ticket",
  bill: "Bill",
};

export default function StationPage() {
  // useSession() has no `role` — this derives it the same way the board
  // does at orders/page.tsx:95, rather than inventing a second rule.
  const { current, me } = useSession();
  const role: AccessRole = me?.role === "kitchen" ? "kitchen" : "owner";
  const businessId = current?.id ?? null;

  const [station, setStation] = useState<Station | null>(null);
  const [name, setName] = useState("");
  const [connected, setConnected] = useState<string[]>([]);
  const [last, setLast] = useState<DrainResult | null>(null);
  const [missed, setMissed] = useState<PendingJob[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  /** The HMAC topic the API handed us. Never derived here. */
  const [topic, setTopic] = useState<string | null>(null);

  // One pass at a time. A ten-second poll landing on top of a slow USB
  // write would otherwise have two drains claiming the same job from the
  // same tab.
  const running = useRef(false);

  /**
   * One transport object that routes each write to the right API.
   *
   * `drain()` takes a single transport by design — it should not know that
   * USB and serial exist. This resolves per device_key from the station's
   * own outputs, so a machine holding one of each works without `drain()`
   * learning anything about either.
   */
  const transportFor = useCallback((outputs: Output[]): PrinterTransport => {
    const usb = usbTransport();
    const serial = serialTransport();
    const byKey = new Map(outputs.map((o) => [o.deviceKey, o.transport]));
    return {
      async granted() {
        return [...(await usb.granted()), ...(await serial.granted())];
      },
      write(deviceKey, bytes) {
        return byKey.get(deviceKey) === "serial"
          ? serial.write(deviceKey, bytes)
          : usb.write(deviceKey, bytes);
      },
    };
  }, []);

  /**
   * The manual Print/Reprint button both the Missed and Failed lists use.
   *
   * The actual logic is `reprintJob` in lib/station/loop.ts, tested there —
   * this page has no test harness of its own. `client.claim` can throw for
   * reasons that are not "someone else took it" — a bill job this principal
   * may not claim, a station revoked since the page loaded. It used to sit
   * outside any try/catch at all (M1): an unhandled rejection, with nothing
   * shown on the page.
   */
  const reprint = useCallback(
    async (m: PendingJob, onResolved: () => void) => {
      if (!businessId || !station) return;
      const client = stationApi(businessId, station.id);
      const refs: StationOutputRef[] = station.outputs.map((o) => ({
        job: o.job,
        deviceKey: o.deviceKey,
      }));
      const out = await reprintJob(client, transportFor(station.outputs), refs, m);
      switch (out.outcome) {
        case "taken":
        case "printed":
          onResolved();
          return;
        case "no-output":
          return;
        case "failed":
        case "error":
          setError(out.error);
          return;
      }
    },
    [businessId, station, transportFor],
  );

  const load = useCallback(async () => {
    if (!businessId) return;
    const id = stationIdFor(businessId);
    if (!id) return setStation(null);
    try {
      const all = await api.get<Station[]>(`/businesses/${businessId}/stations`);
      const mine = all.find((s) => s.id === id) ?? null;
      if (!mine) {
        // Revoked, or set up against a venue this machine no longer sees.
        forgetStation(businessId);
        setRevoked(true);
      }
      setStation(mine);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this machine");
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tick = useCallback(async () => {
    if (!businessId || !station || running.current || revoked) return;
    running.current = true;
    try {
      // Both transports, because a station can hold one of each: a USB
      // token roll at the counter and a virtual-COM kitchen printer that
      // WebUSB cannot touch on Windows. `granted()` on a browser without
      // the API returns [], so asking both costs nothing.
      const usb = usbTransport();
      const serial = serialTransport();
      setConnected([...(await usb.granted()), ...(await serial.granted())]);

      const refs: StationOutputRef[] = station.outputs.map((o) => ({
        job: o.job,
        deviceKey: o.deviceKey,
      }));
      const client = stationApi(businessId, station.id);
      // One pending() call per pass (I2): drain() already made it to decide
      // what to print, and missed/failed/topic are carried straight back
      // from that same response rather than asking again for the same
      // 16-hour, per-station query ten seconds later.
      const result = await drain(client, transportFor(station.outputs), refs);
      setLast(result);
      setMissed(result.missed);
      setFailed(result.failedReceipts);
      setTopic(result.topic);
      // C1: a claim this pass could not make — a bill job this principal
      // may not claim, a revoked station — no longer throws out of drain()
      // and abandons the rest of the pass, but it must not go unmentioned
      // either.
      setError(result.claimErrors > 0 ? (result.claimError ?? "A ticket could not be claimed") : null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) {
        // This machine is no longer a station. Stop, and say so.
        forgetStation(businessId);
        setRevoked(true);
        setStation(null);
      } else {
        setError(e instanceof Error ? e.message : "Printing failed");
      }
    } finally {
      running.current = false;
    }
  }, [businessId, station, revoked, transportFor]);

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(t);
  }, [tick]);

  /*
   * The ping, on top of the poll.
   *
   * An accepted round should print now, not up to ten seconds from now, and
   * a socket is how that happens. It stays strictly an optimisation: the
   * poll above never stops, so a dropped message means a ticket arrives
   * late rather than not at all. openChannel is the same helper the
   * notifications provider uses, and the topic comes from the API — a
   * leaked business id must not yield a subscription to that venue.
   */
  useEffect(() => {
    if (!topic) return;
    const config = realtimeConfig();
    if (!config) return;

    const channel = openChannel({ ...config, topic, onPing: () => void tick() });
    return () => channel.close();
  }, [topic, tick]);

  async function setup() {
    if (!businessId) return;
    const created = await api.post<Station>(`/businesses/${businessId}/stations`, { name });
    rememberStation(businessId, created.id);
    setRevoked(false);
    setStation({ ...created, outputs: [] });
  }

  /**
   * Link a printer to one of this station's jobs, over either transport.
   *
   * Serial exists here for one reason: a thermal printer Windows has
   * installed as an ordinary system printer is claimed by `usbprint.sys`,
   * and the WebUSB chooser below comes up empty for it. A virtual COM port
   * sidesteps that — Windows hands serial ports to whichever application
   * opens them — which is why the error below points there instead of at a
   * driver swap.
   */
  async function link(job: PrintJob, paperWidth: 58 | 80, mode: Transport) {
    if (!businessId || !station) return;
    try {
      let deviceLabel: string;
      let deviceKey: string;

      if (mode === "usb") {
        const nav = navigator as unknown as {
          usb?: {
            requestDevice(o: unknown): Promise<{
              vendorId: number;
              productId: number;
              serialNumber?: string;
              productName?: string;
            }>;
          };
        };
        if (!nav.usb) {
          setError("This browser cannot talk to USB printers. Use Chrome or Edge.");
          return;
        }
        // classCode 7 is the USB printer class.
        const device = await nav.usb.requestDevice({ filters: [{ classCode: 7 }] });
        deviceLabel = device.productName ?? "USB printer";
        deviceKey = deviceKeyOf(device);
      } else {
        const nav = navigator as unknown as {
          serial?: {
            requestPort(): Promise<{ getInfo(): { usbVendorId?: number; usbProductId?: number } }>;
          };
        };
        if (!nav.serial) {
          setError("This browser cannot talk to serial printers. Use Chrome or Edge.");
          return;
        }
        const port = await nav.serial.requestPort();
        deviceKey = serialKeyOf(port.getInfo());
        deviceLabel = "Serial printer";
      }

      await api.post(`/businesses/${businessId}/stations/${station.id}/outputs`, {
        job,
        deviceLabel,
        deviceKey,
        transport: mode,
        paperWidth,
      });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "Only the owner can put a bill printer on a machine."
          : mode === "usb"
            ? "No printer was chosen. On Windows, a printer installed as a normal Windows printer cannot be used here — try Link via Serial instead."
            : "No port was chosen.",
      );
    }
  }

  if (!businessId) {
    return (
      <Empty
        title="Pick a venue first"
        body="Choose a business from the switcher before setting up a station."
      />
    );
  }

  if (revoked) {
    return (
      <section className="p-6">
        <Banner tone="error">
          This machine is no longer a station. Ask the owner to set it up again.
        </Banner>
      </section>
    );
  }

  if (!station) {
    return (
      <section className="mx-auto max-w-sm space-y-4 p-6">
        <h1 className="font-display text-xl font-semibold">Set up this machine</h1>
        <p className="text-[14px] text-muted">
          Name it after where it stands — Counter, Kitchen — so the owner&apos;s list makes
          sense from across the shop.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <Button variant="primary" disabled={name.trim().length === 0} onClick={() => void setup()}>
          Set up this machine
        </Button>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-xl space-y-5 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-xl font-semibold">{station.name}</h1>
        <span className="text-[13px] text-faint">
          {last ? `${last.printed} printed · ${last.failed} failed` : "Starting…"}
        </span>
      </header>

      {error && <Banner tone="error">{error}</Banner>}

      {last?.disconnected.map((job) => (
        <div key={job} data-testid={`disconnected-${job}`}>
          <Banner tone="error">
            {JOB_LABEL[job]} printer not connected — tickets are waiting, and will print
            themselves when it is back.
          </Banner>
        </div>
      ))}

      <ul className="space-y-2">
        {PRINT_JOBS.map((job) => {
          const out = station.outputs.find((o) => o.job === job);
          const live = out ? connected.includes(out.deviceKey) : false;
          return (
            <li
              key={job}
              data-testid={`output-${job}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-line p-3"
            >
              <span>
                <strong className="text-[14px]">{JOB_LABEL[job]}</strong>
                <span className="block text-[13px] text-faint">
                  {out
                    ? `${out.deviceLabel} · ${out.transport.toUpperCase()} · ${out.paperWidth}mm · ${
                        live ? "Connected" : "Not connected"
                      }`
                    : "No printer"}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => void link(job, 58, "usb")}>
                    USB 58mm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void link(job, 80, "usb")}>
                    USB 80mm
                  </Button>
                </span>
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" onClick={() => void link(job, 58, "serial")}>
                    Serial 58mm
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void link(job, 80, "serial")}>
                    Serial 80mm
                  </Button>
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {missed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[14px] font-semibold">Missed</h2>
          <p className="text-[13px] text-faint">
            Older than half an hour. Nothing here prints on its own.
          </p>
          <ul className="space-y-1.5">
            {missed.map((m) => (
              <li key={`${m.eventId}:${m.job}`} className="flex items-center justify-between text-[13px]">
                <span>
                  Table {m.tableLabel} · token {m.token} · {JOB_LABEL[m.job]}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void reprint(m, () => setMissed((rest) => rest.filter((x) => x !== m)))}
                >
                  Print
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {failed.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[14px] font-semibold">Failed</h2>
          <p className="text-[13px] text-faint">
            The printer refused these, or the write never finished. They retry on their
            own next pass; Reprint forces it now.
          </p>
          <ul className="space-y-1.5">
            {failed.map((f) => (
              <li
                key={`${f.eventId}:${f.job}`}
                className="space-y-0.5 text-[13px]"
                data-testid={`failed-${f.eventId}-${f.job}`}
              >
                <div className="flex items-center justify-between">
                  <span>
                    Table {f.tableLabel} · token {f.token} · {JOB_LABEL[f.job]}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void reprint(f, () => setFailed((rest) => rest.filter((x) => x !== f)))}
                  >
                    Reprint
                  </Button>
                </div>
                {f.error && <p className="text-faint">{f.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {role === "owner" && (
        <p className="text-[13px] text-faint">
          Manage every machine in <a className="underline" href="/settings/printing">Settings → Printing</a>.
        </p>
      )}
    </section>
  );
}
