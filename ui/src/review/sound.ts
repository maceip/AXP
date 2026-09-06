/* Tiny synthesised sounds for the review tools. Opt-in, off by default,
 * remembered per browser. No audio files: a filtered noise burst for the
 * marker, a damped sine for the stamp. */

const KEY = "axp.review.sound";
let context: AudioContext | null = null;

export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}
export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode: sound simply stays off */
  }
}

function ctx(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** A short squeak, like a felt tip lifting off paper. */
export function squeak(pitch = 1): void {
  if (!soundEnabled()) return;
  const audio = ctx();
  if (!audio) return;
  const length = 0.09;
  const buffer = audio.createBuffer(
    1,
    Math.ceil(audio.sampleRate * length),
    audio.sampleRate,
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const source = audio.createBufferSource();
  source.buffer = buffer;
  const filter = audio.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1800 * pitch;
  filter.Q.value = 6;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.18, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + length);
  source.connect(filter).connect(gain).connect(audio.destination);
  source.start();
}

/** A soft thunk for a stamp landing. */
export function thunk(): void {
  if (!soundEnabled()) return;
  const audio = ctx();
  if (!audio) return;
  const osc = audio.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(140, audio.currentTime);
  osc.frequency.exponentialRampToValueAtTime(60, audio.currentTime + 0.12);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.25, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.16);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.18);
}
