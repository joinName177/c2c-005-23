import { validateCropRange, type CropRange } from '../core/models';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import { encodeWav } from './web-audio-effects.adapter';

export interface DecodedAudio { sampleRate: number; duration: number; channels: Float32Array[] }
interface Dependencies { decode(blob: Blob): Promise<DecodedAudio> }
async function browserDecode(blob: Blob): Promise<DecodedAudio> {
  const context = new AudioContext();
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, channels: Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index).slice()) };
  await context.close();
  return result;
}
function sliceWav(audio: DecodedAudio, range: CropRange): Blob {
  const start = Math.floor(range.start * audio.sampleRate);
  const end = Math.floor(range.end * audio.sampleRate);
  const channels = audio.channels.map((channel) => channel.slice(start, end));
  return encodeWav({ sampleRate: audio.sampleRate, channels });
}
export class WebAudioCropperAdapter implements AudioCropperPort {
  constructor(private readonly deps: Dependencies = { decode: browserDecode }) {}
  async inspect(blob: Blob) { const audio = await this.deps.decode(blob); return { duration: audio.duration, needsCrop: audio.duration > 10 }; }
  async crop(blob: Blob, range: CropRange) {
    const audio = await this.deps.decode(blob);
    const safe = { start: Math.max(0, range.start), end: Math.min(audio.duration, range.start + Math.min(10, range.end - range.start)) };
    const error = validateCropRange(safe, audio.duration); if (error) throw new Error(error);
    return { blob: sliceWav(audio, safe), duration: safe.end - safe.start };
  }
}
