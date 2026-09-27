import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEscalation, ESCALATION_STEPS_MS } from "./escalation";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createEscalation", () => {
  it("re-alerts an order nobody has acknowledged", () => {
    // One chime in a loud kitchen is a missed order.
    const onRealert = vi.fn();
    createEscalation({ onRealert }).arm(1);

    vi.advanceTimersByTime(ESCALATION_STEPS_MS[0]!);
    expect(onRealert).toHaveBeenCalledWith(1);
  });

  it("escalates a second time, then stops for good", () => {
    // Capped by construction. A kitchen alert that never gives up gets the
    // tablet muted, which loses every future order too.
    const onRealert = vi.fn();
    createEscalation({ onRealert }).arm(1);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onRealert).toHaveBeenCalledTimes(ESCALATION_STEPS_MS.length);
  });

  it("stops the moment the order is acknowledged", () => {
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);

    vi.advanceTimersByTime(ESCALATION_STEPS_MS[0]! - 1);
    escalation.acknowledge(1);
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(onRealert).not.toHaveBeenCalled();
  });

  it("stops the rest after acknowledging mid-way", () => {
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);

    vi.advanceTimersByTime(ESCALATION_STEPS_MS[0]!);
    expect(onRealert).toHaveBeenCalledTimes(1);

    escalation.acknowledge(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onRealert).toHaveBeenCalledTimes(1);
  });

  it("arming the same order twice does not double the chimes", () => {
    // Two deliveries of one order — a replayed ping overlapping a poll —
    // must not stack two escalation chains onto the same ticket.
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);
    escalation.arm(1);

    vi.advanceTimersByTime(ESCALATION_STEPS_MS[0]!);
    expect(onRealert).toHaveBeenCalledTimes(1);
  });

  it("tracks several orders independently", () => {
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);
    escalation.arm(2);
    escalation.acknowledge(1);

    vi.advanceTimersByTime(ESCALATION_STEPS_MS[0]!);
    expect(onRealert).toHaveBeenCalledTimes(1);
    expect(onRealert).toHaveBeenCalledWith(2);
  });

  it("acknowledgeAll silences everything at once", () => {
    // Opening the board is an acknowledgement of everything on it.
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);
    escalation.arm(2);
    escalation.acknowledgeAll();

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onRealert).not.toHaveBeenCalled();
  });

  it("stops cleanly on unmount", () => {
    // A timer that outlives the component fires into a dead tree.
    const onRealert = vi.fn();
    const escalation = createEscalation({ onRealert });
    escalation.arm(1);
    escalation.stop();

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(onRealert).not.toHaveBeenCalled();
  });
});
