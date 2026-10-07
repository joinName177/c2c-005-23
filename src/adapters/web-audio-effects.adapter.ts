import { applyEffects, type AudioEffectParams, type EffectRenderResult } from '../core/audio-effects';
import type { AudioEffectsPort, PcmAudio, PlaybackHandle } from '../ports/audio-effects.port';

interface Dependencies {
  decodeAudioBlob(blob: Blob): Promise<{ sampleRate: number; duration: number; channels: Float32Array[] }>;
}

async function browserDecode(blob: Blob) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    return {
      sampleRate: buffer.sampleRate,
      duration: buffer.duration,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()),
    };
  } finally {
    await context.close();
  }
}

/** 统一直用的 16-bit PCM WAV 编码器；样本在写入前再做一次防御性夹取。 */
export function encodeWav(audio: { sampleRate: number; channels: Float32Array[] }): Blob {
  const length = Math.max(0, ...audio.channels.map((channel) => channel.length));
  const channels = audio.channels;
  const buffer = new ArrayBuffer(44 + length * channels.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * channels.length * 2, true); write(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true); view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels.length * 2, true); view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * channels.length * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) for (const channel of channels) {
    const value = Math.max(-1, Math.min(1, channel[i] ?? 0));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export class WebAudioEffectsAdapter implements AudioEffectsPort {
  constructor(private readonly deps: Dependencies = { decodeAudioBlob: browserDecode }) {}

  async decode(blob: Blob): Promise<PcmAudio> {
    const decoded = await this.deps.decodeAudioBlob(blob);
    let peak = 0;
    for (const channel of decoded.channels) for (let i = 0; i < channel.length; i += 1) {
      const absolute = Math.abs(channel[i]);
      if (absolute > peak) peak = absolute;
    }
    return { ...decoded, peak };
  }

  render(source: PcmAudio, params: AudioEffectParams): EffectRenderResult {
    return applyEffects(source, params);
  }

  encode(rendered: EffectRenderResult): Blob {
    return encodeWav(rendered);
  }

  async play(source: PcmAudio): Promise<PlaybackHandle> {
    const context = new AudioContext();
    const buffer = context.createBuffer(source.channels.length, source.channels[0]?.length ?? 0, source.sampleRate);
    source.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    // onended 既覆盖自然播完也覆盖 stop()，所以 done 不会挂起。
    const done = new Promise<void>((resolve) => {
      node.onended = () => { context.close(); resolve(); };
    });
    node.start();
    return {
      done,
      stop: () => { try { node.stop(); } catch { /* 已结束时忽略 */ } },
    };
  }
}
