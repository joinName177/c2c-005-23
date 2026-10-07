import type { CropRange, ProcessFingerprint, TuneSettings } from '../core/models';

export interface ProcessedAudio { blob: Blob; duration: number; peak: number; clipped: boolean; eventCount: number; fingerprint: ProcessFingerprint }

export interface AudioCropperPort {
  inspect(blob: Blob): Promise<{ duration: number; needsCrop: boolean }>;
  crop(blob: Blob, range: CropRange): Promise<{ blob: Blob; duration: number }>;
  /** 从原始音频的指定片段一次性施加调音参数；不接受已处理音频作为输入，杜绝误差累积。 */
  process(blob: Blob, range: CropRange, settings: TuneSettings, generation: number): Promise<ProcessedAudio>;
}
