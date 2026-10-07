import { clampFades } from '../core/models';
import type { AudioPreviewHandle, AudioPreviewPort } from '../ports/audio-preview.port';
import type { CropRange, TuneSettings } from '../core/models';

interface Dependencies {
  context: AudioContext;
  decode(blob: Blob): Promise<AudioBuffer>;
  now(): number;
}

function browserDependencies(): Dependencies {
  const context = new AudioContext();
  return { context, decode: async (blob) => context.decodeAudioData(await blob.arrayBuffer()), now: () => context.currentTime };
}

/**
 * 实时试听：常驻一个 AudioContext，对同一原始 Blob 缓存解码结果。
 * 音量走 GainNode 恒定增益；淡入淡出用 setTargetCurve（指数斜坡无法过零，故用线性事件）。
 * 新试听一律先 stop 旧 source 并断开，取消在途播放而非排队，杜绝快速拖动积压。
 */
export class WebAudioPreviewAdapter implements AudioPreviewPort {
  private current?: { source: AudioBufferSourceNode; gain: GainNode };
  private cached?: { blob: Blob; buffer: AudioBuffer };
  private generation = 0;

  constructor(private readonly deps: Dependencies = browserDependencies()) {}

  cancel() {
    this.generation += 1;
    this.teardown();
  }

  private teardown() {
    if (!this.current) return;
    try { this.current.source.onended = null; this.current.source.stop(); } catch { /* 已停止 */ }
    this.current.source.disconnect();
    this.current.gain.disconnect();
    this.current = undefined;
  }

  async preview(blob: Blob, range: CropRange, settings: TuneSettings): Promise<AudioPreviewHandle> {
    const token = ++this.generation;
    this.teardown();
    if (!this.cached || this.cached.blob !== blob) this.cached = { blob, buffer: await this.deps.decode(blob) };
    // 解码期间用户已继续拖动：本次结果过期，直接放弃，不接线不发声。
    if (token !== this.generation) return { stop: () => {} };
    const buffer = this.cached.buffer;
    const offset = Math.max(0, range.start);
    const duration = Math.max(0.001, Math.min(buffer.duration - offset, range.end - range.start));
    const source = this.deps.context.createBufferSource();
    source.buffer = buffer;
    const gain = this.deps.context.createGain();
    source.connect(gain).connect(this.deps.context.destination);

    const startAt = this.deps.now() + 0.02;
    const { fadeIn, fadeOut } = clampFades(settings.fadeIn, settings.fadeOut, duration);
    gain.gain.setValueAtTime(settings.gain, startAt);
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.linearRampToValueAtTime(settings.gain, startAt + fadeIn);
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(settings.gain, startAt + Math.max(0, duration - fadeOut));
      gain.gain.linearRampToValueAtTime(0.0001, startAt + duration);
    }
    source.start(startAt, offset, duration);
    this.current = { source, gain };
    source.onended = () => {
      if (this.current?.source === source) this.current = undefined;
      source.disconnect(); gain.disconnect();
    };
    return {
      stop: () => {
        // 只停止自己这一代；晚返回的旧 handle 不能杀掉新试听。
        if (token !== this.generation) return;
        this.teardown();
      },
    };
  }
}
