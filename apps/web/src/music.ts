export const LIMIT = 300_000_000;
// Admission policy, not a prediction about DSP or network speed.
export const IMMEDIATE = 12_000_000;

export async function checkFile(file: File) {
  const detail = `Selected: ${file.size.toLocaleString('en-US')} bytes · Limit: 300 MB.`;
  if (file.size > LIMIT) throw Error(`Set too large. ${detail}`);
  const reject = () => { throw Error(`Choose an MPEG Layer III (.mp3) file. ${detail}`); };
  if (!/\.mp3$/i.test(file.name) || !file.size) reject();
  const bytes = async (start: number, length: number) =>
    new Uint8Array(await file.slice(start, start + length).arrayBuffer());
  const h = await bytes(0, 10);
  let offset = 0;
  if (h[0] === 73 && h[1] === 68 && h[2] === 51) {
    if (h.length !== 10 || ![2, 3, 4].includes(h[3]) || h.slice(6).some(v => v >= 128)) reject();
    offset = 10 + h.slice(6).reduce((n, v) => n * 128 + v, 0) + (h[3] === 4 && h[5] & 16 ? 10 : 0);
  }
  const b = await bytes(offset, 4);
  if (b.length !== 4 || b[0] !== 255 || (b[1] & 224) !== 224 ||
      (b[1] & 24) === 8 || (b[1] & 6) !== 2 || (b[2] >> 4) === 15 ||
      (b[2] & 12) === 12 || (b[3] & 3) === 2) reject();
}

export interface Timeline {
  version: 1;
  duration_s: number;
  beats: { time_s: number; low_energy: number }[];
}
export function timeline(value: unknown): Timeline {
  const t = value as Timeline;
  let last = -1;
  if (!t || Object.keys(t).length !== 3 || t.version !== 1 ||
      !Number.isFinite(t.duration_s) || t.duration_s <= 0 || !Array.isArray(t.beats) ||
      !t.beats.every(b => {
        if (!b || Object.keys(b).length !== 2 || !Number.isFinite(b.time_s) ||
            b.time_s <= last || b.time_s >= t.duration_s || b.time_s < 0 ||
            !Number.isFinite(b.low_energy) || b.low_energy < 0 || b.low_energy > 1) return false;
        last = b.time_s;
        return true;
      })) throw Error('The analysis timeline is invalid.');
  return t;
}
export function coneAt(t: Timeline | null, seconds: number, ended = false) {
  if (!t || ended || seconds >= t.duration_s) return 0;
  let lo = 0, hi = t.beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t.beats[mid].time_s <= seconds) lo = mid + 1;
    else hi = mid;
  }
  const beat = t.beats[lo - 1];
  return beat ? beat.low_energy * Math.max(0, 1 - (seconds - beat.time_s) / .16) : 0;
}

// Call only when rendering a playing frame. A result delivered during pause
// cannot move the room or accrue crowd time while the clock is stopped.
export class NightClock {
  result: Timeline | null = null;
  joined: number | null = null;
  sample(seconds: number, ended = false) {
    if (this.result && this.joined === null && !ended) this.joined = seconds;
    return { pulse: coneAt(this.result, seconds, ended),
      crowdAge: this.joined === null ? -1 : seconds - this.joined };
  }
}
