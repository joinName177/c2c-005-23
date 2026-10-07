export type EmotionLabel = '暴躁老哥' | '温柔姐姐' | '阴阳怪气' | '元气满满';
export type StudioStage = 'record' | 'crop' | 'tune' | 'emotion' | 'cover' | 'collection';
export interface CropRange { start: number; end: number }
/** 调音参数：增益倍数与首尾淡入淡出秒数，始终作用于“裁剪后保留的原片段”，不累积 */
export interface TuneSettings { gain: number; fadeIn: number; fadeOut: number }
/** 一次离线处理的结果指纹：参数 + 来源片段范围 + 序号，用于保证分析/保存的是同一次选择 */
export interface ProcessFingerprint { sourceStart: number; sourceEnd: number; settings: TuneSettings; generation: number }
export interface AudioFeatures { loudness: number; dynamics: number; pitch: number; zeroCrossing: number; pauseRatio: number; tempoVariation: number }
export interface EmotionResult { label: EmotionLabel; confidence: number; explanation: string; scores: Record<EmotionLabel, number> }
export interface CoverConfig {
  label: EmotionLabel;
  title: string;
  bubbleText: string;
  bubbleX: number;
  bubbleY: number;
  palette: [string, string, string];
  filter: 'none' | 'mono' | 'saturate' | 'warm' | 'cool';
  ratio: 'square' | 'portrait';
}
export interface VoiceMeme {
  id: string;
  title: string;
  emotion: EmotionLabel;
  confidence: number;
  features: AudioFeatures;
  audio: Blob;
  duration: number;
  cover: Blob;
  coverConfig: CoverConfig;
  createdAt: string;
}

export const MAX_CLIP_SECONDS = 10;
export const TUNE_GAIN_MIN = 0.2;
export const TUNE_GAIN_MAX = 3;
export const TUNE_GAIN_STEP = 0.05;

export function validateCropRange(range: CropRange, duration: number): string | undefined {
  if (range.start < 0) return '裁剪起点不能小于 0';
  if (range.end <= range.start) return '裁剪终点必须晚于起点';
  if (range.end > duration) return '裁剪终点超出音频时长';
  if (range.end - range.start > MAX_CLIP_SECONDS) return '裁剪片段不能超过 10 秒';
  return undefined;
}

/** 淡入淡出不得越过片段：各自最长为片段一半，二者合计不超过片段；返回可直接使用的安全秒数 */
export function clampFades(fadeIn: number, fadeOut: number, duration: number): { fadeIn: number; fadeOut: number } {
  const finite = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
  let inSeconds = finite(fadeIn);
  let outSeconds = finite(fadeOut);
  const half = duration / 2;
  inSeconds = Math.min(inSeconds, half);
  outSeconds = Math.min(outSeconds, half);
  if (inSeconds + outSeconds > duration) {
    const scale = duration / (inSeconds + outSeconds);
    inSeconds *= scale;
    outSeconds *= scale;
  }
  return { fadeIn: inSeconds, fadeOut: outSeconds };
}

export function validateTuneSettings(settings: TuneSettings, duration: number): string | undefined {
  if (!Number.isFinite(settings.gain) || settings.gain <= 0) return '音量倍数必须为正数';
  if (settings.fadeIn < 0 || settings.fadeOut < 0) return '淡化长度不能为负';
  const safe = clampFades(settings.fadeIn, settings.fadeOut, duration);
  if (safe.fadeIn + safe.fadeOut > duration + 1e-6) return '淡入淡出总长度超过片段';
  return undefined;
}

export function sameTuneSettings(a: TuneSettings, b: TuneSettings): boolean {
  return a.gain === b.gain && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;
}

export const defaultTuneSettings: TuneSettings = { gain: 1, fadeIn: 0, fadeOut: 0 };
