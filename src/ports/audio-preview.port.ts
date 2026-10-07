import type { CropRange, TuneSettings } from '../core/models';

/**
 * 实时试听端口：拖动参数时只连接内存中的播放图，不做离线渲染与 WAV 编码。
 * 每次以原始音频解码后的保留片段为输入，因此试听结果与最终一次渲染使用同一依据。
 */
export interface AudioPreviewHandle { stop: () => void }
export interface AudioPreviewPort {
  /** 取消当前在播试听（旧参数）。新参数到达时先 abort，保证最多一条在途播放。 */
  cancel(): void;
  /** 用最新参数试听；实现需取消上一条播放。返回的 handle 可提前停止。 */
  preview(blob: Blob, range: CropRange, settings: TuneSettings): Promise<AudioPreviewHandle>;
}
