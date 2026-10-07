import { validateCropRange, validateTuneSettings, type CropRange, type TuneSettings } from '../core/models';
import { detectClipping, renderChannels } from '../core/audio-dsp';
import type { AudioCropperPort, ProcessedAudio } from '../ports/audio-cropper.port';

export interface DecodedAudio { sampleRate: number; duration: number; channels: Float32Array[] }
interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function browserDecode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  await context.close();
  return result;
}
function sliceChannels(audio: DecodedAudio, range: CropRange) {
  const start = Math.floor(range.start * audio.sampleRate);
  const end = Math.floor(range.end * audio.sampleRate);
  return { channels: audio.channels.map((channel) => channel.slice(start, end)), length: end - start };
}
function encodeWav(sampleRate: number, channels: Float32Array[], length: number) {
  const buffer = new ArrayBuffer(44 + length * channels.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length * channels.length * 2, true); write(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 2, true); view.setUint16(32, channels.length * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * channels.length * 2, true);
  let offset = 44;
  for (let i = 0; i < length; i += 1) for (const channel of channels) { const value = Math.max(-1, Math.min(1, channel[i] ?? 0)); view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true); offset += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}
export class WebAudioCropperAdapter implements AudioCropperPort {
  constructor(private readonly deps: Dependencies = { decode: browserDecode }) {}
  async inspect(blob: Blob) { const audio = await this.deps.decode(blob); return { duration: audio.duration, needsCrop: audio.duration > 10 }; }
  async crop(blob: Blob, range: CropRange) {
    const audio = await this.deps.decode(blob);
    const safe = { start: Math.max(0, range.start), end: Math.min(audio.duration, range.start + Math.min(10, range.end - range.start)) };
    const error = validateCropRange(safe, audio.duration); if (error) throw new Error(error);
    const { channels, length } = sliceChannels(audio, safe);
    return { blob: encodeWav(audio.sampleRate, channels, length), duration: safe.end - safe.start };
  }
  async process(blob: Blob, range: CropRange, settings: TuneSettings, generation: number): Promise<ProcessedAudio> {
    const audio = await this.deps.decode(blob);
    const safe = { start: Math.max(0, range.start), end: Math.min(audio.duration, range.start + Math.min(10, range.end - range.start)) };
    const rangeError = validateCropRange(safe, audio.duration); if (rangeError) throw new Error(rangeError);
    const duration = safe.end - safe.start;
    const tuneError = validateTuneSettings(settings, duration); if (tuneError) throw new Error(tuneError);
    // 始终从刚解码出的原片段渲染，调用方传入的也必须是原始音频，重复调整不会叠加。
    const { channels: sourceSlice, length } = sliceChannels(audio, safe);
    const rendered = renderChannels(sourceSlice, duration, settings);
    const report = detectClipping(rendered);
    return {
      blob: encodeWav(audio.sampleRate, rendered, length),
      duration,
      peak: report.peak,
      clipped: report.clipped,
      eventCount: report.eventCount,
      fingerprint: { sourceStart: safe.start, sourceEnd: safe.end, settings: { ...settings }, generation },
    };
  }
}
