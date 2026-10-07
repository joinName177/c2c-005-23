import type { AudioEffectParams } from '../core/audio-effects';
import type { EffectRenderResult } from '../core/audio-effects';

export interface PcmAudio {
  sampleRate: number;
  duration: number;
  channels: Float32Array[];
  /** 解码头的峰值（所有声道），用于拖动时零成本预判削波 */
  peak: number;
}

export interface PlaybackHandle {
  stop(): void;
  /** 播放结束（自然播完或被 stop 打断）时 resolve */
  done: Promise<void>;
}

/**
 * 音频效果端口：解码保留片段 → 在 PCM 上渲染音量/淡化 → 编码成品 → 播放。
 * 渲染与编码拆成两步，使实时试听可以只做内存处理，确认时才承担编码开销。
 */
export interface AudioEffectsPort {
  decode(blob: Blob): Promise<PcmAudio>;
  render(source: PcmAudio, params: AudioEffectParams): EffectRenderResult;
  encode(rendered: EffectRenderResult): Blob;
  play(source: PcmAudio): Promise<PlaybackHandle>;
}
