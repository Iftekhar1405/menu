import { describe, expect, it, vi } from "vitest";
import { createChime } from "./chime";

describe("createChime", () => {
  it("stays silent until a gesture has unlocked audio", () => {
    // Browsers refuse to start an AudioContext before a user gesture.
    // Playing anyway produces a suspended context and silence that reads as
    // a bug, so the gate is explicit rather than left to the platform.
    const sink = vi.fn();
    const chime = createChime({ sink });

    chime.play("order");
    expect(sink).not.toHaveBeenCalled();
    expect(chime.isReady()).toBe(false);
  });

  it("plays once unlocked", () => {
    const sink = vi.fn();
    const chime = createChime({ sink });

    chime.unlock();
    chime.play("order");
    expect(sink).toHaveBeenCalledWith("order");
  });

  it("stays silent when muted", () => {
    const sink = vi.fn();
    const chime = createChime({ sink, startUnlocked: true });

    chime.setMuted(true);
    chime.play("order");
    expect(sink).not.toHaveBeenCalled();
  });

  it("plays again when unmuted", () => {
    const sink = vi.fn();
    const chime = createChime({ sink, startUnlocked: true, muted: true });

    chime.setMuted(false);
    chime.play("order");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("starts muted when the stored preference says so", () => {
    const sink = vi.fn();
    const chime = createChime({ sink, startUnlocked: true, muted: true });

    chime.play("order");
    expect(sink).not.toHaveBeenCalled();
    expect(chime.isMuted()).toBe(true);
  });

  it("reports mute changes so the preference can be persisted", () => {
    const onMutedChange = vi.fn();
    const chime = createChime({ sink: vi.fn(), onMutedChange });

    chime.setMuted(true);
    expect(onMutedChange).toHaveBeenCalledWith(true);
  });

  it("unlocking twice is harmless", () => {
    const chime = createChime({ sink: vi.fn() });
    chime.unlock();
    chime.unlock();
    expect(chime.isReady()).toBe(true);
  });

  it("does not throw when the audio device fails mid-service", () => {
    // A bluetooth speaker walking out of range takes the output with it.
    // The notification is already on screen; losing the render over the
    // sound would be the worse failure.
    const chime = createChime({
      sink: () => {
        throw new Error("no output device");
      },
      startUnlocked: true,
    });
    expect(() => chime.play("order")).not.toThrow();
  });
});
