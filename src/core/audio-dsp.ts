import { clampFades, type TuneSettings } from './models';

/** DSP 纯函数：只处理采样数值，不触碰任何浏览器 API，保证可测试、可复用。 */

// PCM 16-bit 编码阈值以上才算“可察觉”的削波：超过该值的样本在 16bit 量化后必被硬切
export const PCM16_CEILING = 32767 / 32768;
// 只要有极少量样本越限即提示，避免瞬时削波被“占比”淹没
const CLIP_MIN_EVENTS = 1;

function fadeMultiplier(position: number, duration: number, fadeIn: number, fadeOut: number): number {
  let gain = 1;
  if (fadeIn > 0 && position < fadeIn) gain *= Math.sin(((position / fadeIn) * Math.PI) / 2) ** 2;
  const tailPosition = duration - position;
  if (fadeOut > 0 && tailPosition < fadeOut) gain *= Math.sin(((tailPosition / fadeOut) * Math.PI) / 2) ** 2;
  return gain;
}

/**
 * 以保留的原片段为唯一输入，一次性施加增益与首尾淡入淡出。
 * 绝不基于已处理结果再次处理，因此重复调整不会累积放大误差。
 */
export function renderChannels(source: Float32Array[], duration: number, settings: TuneSettings): Float32Array[] {
  const safeFades = clampFades(settings.fadeIn, settings.fadeOut, duration);
  return source.map((channel) => {
    const output = new Float32Array(channel.length);
    const sampleRate = channel.length / duration;
    for (let i = 0; i < channel.length; i += 1) {
      const position = i / sampleRate;
      const envelope = fadeMultiplier(position, duration, safeFades.fadeIn, safeFades.fadeOut);
      output[i] = channel[i] * settings.gain * envelope;
    }
    return output;
  });
}

export interface ClipReport { clipped: boolean; eventCount: number; peak: number }

/** 削波检测：峰值按 16bit 量化上限判定，至少一个样本越限即“可察觉”。 */
export function detectClipping(channels: Float32Array[]): ClipReport {
  let eventCount = 0;
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i]);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > PCM16_CEILING) eventCount += 1;
    }
  }
  return { clipped: eventCount >= CLIP_MIN_EVENTS, eventCount, peak };
}
