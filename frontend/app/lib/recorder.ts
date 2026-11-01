/* Short raw-audio capture for beeps and clicks.

   Echo cancellation, noise suppression and auto-gain are all OFF: they
   are tuned for speech and would eat or reshape exactly the beeps and
   clicks we want to measure. Samples are taken straight off the mic
   (ScriptProcessor works on iOS Safari too), downsampled to 16 kHz and
   encoded as 16-bit WAV in the browser, so the backend needs no codecs.
   Callers must only record while nothing is being spoken. */

export interface Recording {
  file: File;
  seconds: number;
}

export interface LiveMic {
  analyser: AnalyserNode;
  done: Promise<Recording>;
  stop: () => void;
}

const TARGET_RATE = 16000;

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

export async function recordClip(seconds: number): Promise<LiveMic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(analyser);
  src.connect(proc);
  // ScriptProcessor only runs when connected to a destination; a muted
  // gain keeps the mic from playing back through the speaker.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  proc.connect(mute);
  mute.connect(ctx.destination);

  let finish: () => void = () => undefined;
  const stopped = new Promise<void>((res) => (finish = res));
  const timer = setTimeout(() => finish(), seconds * 1000);

  const done = stopped.then(async () => {
    clearTimeout(timer);
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    const n = chunks.reduce((k, c) => k + c.length, 0);
    const all = new Float32Array(n);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    const rate = ctx.sampleRate;
    await ctx.close().catch(() => undefined);
    const pcm = downsample(all, rate, TARGET_RATE);
    return {
      file: new File([encodeWav(pcm, TARGET_RATE)], "clip.wav", { type: "audio/wav" }),
      seconds: pcm.length / TARGET_RATE,
    };
  });
  return { analyser, done, stop: () => finish() };
}

/* Issues where the sound is the evidence. */
export const SOUND_WORDS =
  /beep|sound|noise|click|buzz|hum\b|alarm|rattl|whin|squeal|tick|awaaz|aawaz|awaz|बीप|आवाज़|आवाज|शोर/i;

/* /api/listen result: measured features + Muse Wonder's hearing. */
export interface Heard {
  features: {
    beeps: number;
    beep_ms: number | null;
    beep_interval_ms: number | null;
    beep_hz: number | null;
    clicks: number;
    rms_dbfs: number | null;
    duration_s: number;
  };
  wonder: { beeps: number | null; clicks: number | null; sound: string } | null;
  agree: boolean;
  rerecord: boolean;
  summary: string;
}
