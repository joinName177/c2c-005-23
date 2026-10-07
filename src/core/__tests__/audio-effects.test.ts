import { describe, expect, it } from 'vitest';
import {
  applyEffects,
  clampEffectParams,
  predictsClipping,
  sameParams,
  DEFAULT_EFFECT_PARAMS,
  MAX_GAIN,
  type PcmSource,
} from '../audio-effects';

const source = (samples: number[], sampleRate = 10): PcmSource => ({
  sampleRate,
  duration: samples.length / sampleRate,
  channels: [Float32Array.from(samples)],
});

describe('clampEffectParams', () => {
  it('keeps gain inside 0..2 and drops non-finite values', () => {
    expect(clampEffectParams({ gain: 3, fadeIn: -1, fadeOut: 2 }, 4)).toEqual({ gain: MAX_GAIN, fadeIn: 0, fadeOut: 2 });
    expect(clampEffectParams({ gain: Number.NaN }, 4)).toEqual(DEFAULT_EFFECT_PARAMS);
  });
  it('never lets the two fades meet or cross the clip boundaries', () => {
    // 片段 1s：淡入 0.4 + 淡出 0.4 = 0.8 ≤ 1，合法；超出时先保淡入再截断淡出。
    const within = clampEffectParams({ fadeIn: 0.4, fadeOut: 0.4 }, 1);
    expect(within.fadeIn).toBeCloseTo(0.4);
    expect(within.fadeOut).toBeCloseTo(0.4);
    const overflow = clampEffectParams({ fadeIn: 0.7, fadeOut: 0.7 }, 1);
    expect(overflow.fadeIn).toBeCloseTo(0.7);
    expect(overflow.fadeOut).toBeCloseTo(0.3);
    expect(overflow.fadeIn + overflow.fadeOut).toBeLessThanOrEqual(1);
    expect(clampEffectParams({ fadeIn: 5 }, 1)).toEqual({ gain: 1, fadeIn: 1, fadeOut: 0 });
  });
});

describe('applyEffects', () => {
  it('is identity at gain 1 with no fades and does not mutate the source', () => {
    const input = source([-0.5, 0, 0.25, 0.5]);
    const snapshot = Float32Array.from(input.channels[0]);
    const result = applyEffects(input, DEFAULT_EFFECT_PARAMS);
    expect(Array.from(result.channels[0])).toEqual([-0.5, 0, 0.25, 0.5]);
    expect(Array.from(input.channels[0])).toEqual(Array.from(snapshot));
    expect(result.rawPeak).toBeCloseTo(0.5);
    expect(result.clippedSamples).toBe(0);
  });

  it('scales gain and counts clipping above full scale', () => {
    const result = applyEffects(source([0.4, 0.8, -0.6]), { gain: 1.5, fadeIn: 0, fadeOut: 0 });
    const values = Array.from(result.channels[0]);
    expect(values[0]).toBeCloseTo(0.6);
    expect(values[1]).toBe(1);
    expect(values[2]).toBeCloseTo(-0.9);
    expect(result.rawPeak).toBeCloseTo(1.2);
    expect(result.peak).toBe(1);
    expect(result.clippedSamples).toBe(1);
  });

  it('applies non-overlapping fade in and fade out from the retained source', () => {
    // 4 samples @10Hz = 0.4s；淡入 0.2s（2 帧）淡出 0.2s（2 帧），两段不相交。
    const result = applyEffects(source([1, 1, 1, 1]), { gain: 1, fadeIn: 0.2, fadeOut: 0.2 });
    const values = Array.from(result.channels[0]);
    expect(values[0]).toBeCloseTo(0.5);
    expect(values[1]).toBeCloseTo(1);
    expect(values[2]).toBeCloseTo(1);
    expect(values[3]).toBeCloseTo(0, 5);
  });

  it('recomputes from the original every time instead of accumulating drift', () => {
    const input = source([0.4, 0.4]);
    const first = applyEffects(input, { gain: 1.5, fadeIn: 0, fadeOut: 0 });
    // 即便拿到上一次结果再处理，正常调用仍以原片段为基准：结果只取决于参数。
    const again = applyEffects(input, { gain: 1.5, fadeIn: 0, fadeOut: 0 });
    expect(Array.from(again.channels[0])).toEqual(Array.from(first.channels[0]));
    expect(sameParams({ gain: 1.5, fadeIn: 0, fadeOut: 0 }, { gain: 1.5, fadeIn: 0, fadeOut: 0 })).toBe(true);
  });
});

describe('predictsClipping', () => {
  it('uses source peak times gain as a conservative drag-time hint', () => {
    expect(predictsClipping(0.6, 2)).toBe(true);
    expect(predictsClipping(0.4, 2)).toBe(false);
    expect(predictsClipping(0.6, 1)).toBe(false);
  });
});
