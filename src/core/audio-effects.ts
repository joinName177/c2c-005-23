/**
 * 音量与首尾淡入淡出的纯计算核心。
 * 不接触任何浏览器 API：所有处理都以保留下来的原片段 PCM 为唯一输入，
 * 每次都重新计算，绝不基于上一次处理结果迭代，因此不会累积放大误差。
 */
export interface AudioEffectParams {
  /** 线性增益倍率，1 = 原音量；范围 0 ~ 2 */
  gain: number;
  /** 头部淡入秒数 */
  fadeIn: number;
  /** 尾部淡出秒数 */
  fadeOut: number;
}

export const MIN_GAIN = 0;
export const MAX_GAIN = 2;
export const DEFAULT_EFFECT_PARAMS: AudioEffectParams = { gain: 1, fadeIn: 0, fadeOut: 0 };

export interface PcmSource {
  sampleRate: number;
  duration: number;
  channels: Float32Array[];
}

export interface EffectRenderResult extends PcmSource {
  /** 处理后（硬限制后）的峰值 0 ~ 1 */
  peak: number;
  /** 硬限制前的峰值，可能超过 1，用于判断削波 */
  rawPeak: number;
  /** 被截断的样本数（所有声道合计） */
  clippedSamples: number;
  /** 样本总数（所有声道合计） */
  totalSamples: number;
}

function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 把参数约束到合法区间。淡入从片段头开始、淡出止于片段尾，
 * 两段之和不得超过片段长度（fadeIn + fadeOut <= duration），
 * 因此淡化永远不会越过边界，也不会相互交叠。
 */
export function clampEffectParams(params: Partial<AudioEffectParams>, duration: number): AudioEffectParams {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, finiteOr(params.gain ?? 1, 1)));
  const fadeIn = Math.min(safeDuration, Math.max(0, finiteOr(params.fadeIn ?? 0, 0)));
  const fadeOut = Math.min(safeDuration - fadeIn, Math.max(0, finiteOr(params.fadeOut ?? 0, 0)));
  return { gain, fadeIn, fadeOut };
}

export function sameParams(a: AudioEffectParams, b: AudioEffectParams): boolean {
  return a.gain === b.gain && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut;
}

/**
 * 拖动滑块时的零成本削波预判：淡化只会衰减，因此用 原峰值 × 增益 预判偏保守，
 * 宁可多提醒，也不让削波悄悄通过。
 */
export function predictsClipping(sourcePeak: number, gain: number): boolean {
  return Number.isFinite(sourcePeak) && Number.isFinite(gain) && sourcePeak * gain > 1;
}

/**
 * 以原片段 PCM 为基准计算处理后的 PCM。输出写入全新的 Float32Array，
 * 不修改输入；重复调用同一参数必然得到同一结果。
 */
export function applyEffects(source: PcmSource, params: AudioEffectParams): EffectRenderResult {
  const safe = clampEffectParams(params, source.duration);
  const frames = source.channels[0]?.length ?? Math.max(0, Math.floor(source.sampleRate * source.duration));
  const fadeInFrames = Math.min(frames, Math.floor(safe.fadeIn * source.sampleRate));
  const fadeOutFrames = Math.min(frames - fadeInFrames, Math.floor(safe.fadeOut * source.sampleRate));

  let peak = 0;
  let rawPeak = 0;
  let clippedSamples = 0;
  const channels = source.channels.map((channel) => {
    const output = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let envelope = safe.gain;
      // 淡入在第 1 个淡化帧处达到满幅；淡出从满幅线性降到 0。两段在中间不相交，
      // 边界处都是 1，因此衔接处没有凹陷。
      if (fadeInFrames > 0 && i < fadeInFrames) envelope *= (i + 1) / fadeInFrames;
      if (fadeOutFrames > 0 && i >= frames - fadeOutFrames) {
        envelope *= (frames - 1 - i) / (fadeOutFrames - 1);
      }
      const raw = (channel[i] ?? 0) * envelope;
      const rawAbs = Math.abs(raw);
      if (rawAbs > rawPeak) rawPeak = rawAbs;
      if (rawAbs > 1) clippedSamples += 1;
      const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      const clampedAbs = Math.abs(clamped);
      if (clampedAbs > peak) peak = clampedAbs;
      output[i] = clamped;
    }
    return output;
  });

  return {
    sampleRate: source.sampleRate,
    duration: frames / source.sampleRate,
    channels,
    peak,
    rawPeak,
    clippedSamples,
    totalSamples: frames * channels.length,
  };
}
