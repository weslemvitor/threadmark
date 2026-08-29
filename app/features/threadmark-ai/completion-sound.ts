type AudioState = "suspended" | "running" | "closed" | string;

interface CompletionGain {
  gain: {
    setValueAtTime(value: number, time: number): void;
    exponentialRampToValueAtTime(value: number, time: number): void;
  };
  connect(destination: unknown): void;
}

interface CompletionOscillator {
  type: string;
  frequency: { setValueAtTime(value: number, time: number): void };
  connect(destination: unknown): void;
  start(time: number): void;
  stop(time: number): void;
}

export interface CompletionAudioContext {
  readonly state: AudioState;
  resume(): Promise<void>;
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): CompletionGain;
  createOscillator(): CompletionOscillator;
}

export function createCompletionSoundController(
  createContext: () => CompletionAudioContext,
) {
  let context: CompletionAudioContext | null = null;

  async function ready(): Promise<CompletionAudioContext | null> {
    if (!context || context.state === "closed") context = createContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        return null;
      }
    }
    return context.state === "running" ? context : null;
  }

  return {
    prime(): void {
      void ready();
    },
    async play(): Promise<boolean> {
      const audio = await ready();
      if (!audio) return false;

      const gain = audio.createGain();
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, audio.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.48);
      gain.connect(audio.destination);

      for (const [index, frequency] of [659.25, 880].entries()) {
        const oscillator = audio.createOscillator();
        const start = audio.currentTime + index * 0.13;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.connect(gain);
        oscillator.start(start);
        oscillator.stop(start + 0.22);
      }
      return true;
    },
  };
}
