/**
 * The sound a new order makes.
 *
 * Synthesised rather than played from a file. A two-note chime is a handful
 * of oscillator nodes, which means no asset to ship, no mp3/ogg/aac matrix
 * to get wrong, nothing to 404 on a bad restaurant connection, and it works
 * the first time on a tablet that has never loaded the page before.
 *
 * Two things gate it, and both are real:
 *
 *  - Browsers refuse to start an AudioContext before a user gesture. Calling
 *    `play()` first thing does not throw usefully; it produces a context
 *    stuck in "suspended" and silence that looks like a bug. So `unlock()`
 *    runs on the first pointer or key event on the dashboard.
 *  - Mute is a real setting in a restaurant, and it has to survive a reload,
 *    so it is read from and written to the same store the rest of the
 *    preferences use.
 */
export type ChimeTone = "order" | "status";

export interface ChimeSink {
  (tone: ChimeTone): void;
}

export interface Chime {
  /** Call from a real user gesture. Idempotent. */
  unlock(): void;
  play(tone: ChimeTone): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** False until a gesture has unlocked audio. */
  isReady(): boolean;
}

export interface ChimeOptions {
  /** Injected in tests; defaults to the WebAudio implementation. */
  sink?: ChimeSink;
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  /** Tests skip the gesture requirement the browser would impose. */
  startUnlocked?: boolean;
}

export function createChime({
  sink,
  muted = false,
  onMutedChange,
  startUnlocked = false,
}: ChimeOptions = {}): Chime {
  let isMuted = muted;
  let ready = startUnlocked;
  let audio: AudioEngine | null = null;

  const emit: ChimeSink =
    sink ??
    ((tone) => {
      audio ??= createAudioEngine();
      audio?.play(tone);
    });

  return {
    unlock() {
      if (ready) return;
      ready = true;
      // Creating the context inside the gesture is the part that matters;
      // one created earlier stays suspended even after a later click.
      if (!sink) audio ??= createAudioEngine();
    },

    play(tone) {
      // Silence rather than an exception. A chime is an enhancement over a
      // notification that is already on screen, and throwing here would
      // take the render down with it.
      if (isMuted || !ready) return;
      try {
        emit(tone);
      } catch {
        // An audio device that disappeared mid-service, typically.
      }
    },

    setMuted(next) {
      isMuted = next;
      onMutedChange?.(next);
    },

    isMuted: () => isMuted,
    isReady: () => ready,
  };
}

// ── WebAudio ────────────────────────────────────────────────────────────────

interface AudioEngine {
  play(tone: ChimeTone): void;
}

/**
 * Two notes rising for an order, one soft note for a status change.
 *
 * Rising reads as "something arrived" and is easy to pick out over kitchen
 * noise without being a alarm; the single note is deliberately quieter,
 * because a diner's phone should acknowledge the change, not announce it.
 */
const VOICES: Record<ChimeTone, { freq: number; at: number; gain: number }[]> = {
  order: [
    { freq: 784, at: 0, gain: 0.18 },
    { freq: 1175, at: 0.11, gain: 0.16 },
  ],
  status: [{ freq: 659, at: 0, gain: 0.1 }],
};

/** Long enough to hear, short enough not to overlap the next order. */
const NOTE_SECONDS = 0.34;

function createAudioEngine(): AudioEngine | null {
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
  if (!Ctor) return null;

  const ctx = new Ctor();

  return {
    play(tone) {
      // A context can be suspended again by the browser when a tab is
      // backgrounded; resuming is cheap and a no-op when it is running.
      void ctx.resume?.();

      const now = ctx.currentTime;
      for (const note of VOICES[tone]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + note.at;

        osc.type = "sine";
        osc.frequency.setValueAtTime(note.freq, start);

        // A short attack instead of an instant one: a square-edged start on
        // a sine is heard as a click before the note.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + NOTE_SECONDS);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + NOTE_SECONDS + 0.02);
      }
    },
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

const MUTE_KEY = "menu.alerts.muted";

export function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Private browsing. A preference that does not persist beats a crash.
  }
}
