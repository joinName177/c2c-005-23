import { describe, expect, it } from 'vitest';
import { PCM16_CEILING, detectClipping, renderChannels } from '../audio-dsp';

describe('audio-dsp renderChannels', () => {
  it('applies gain from the source every time without accumulation', () => {
    const source = [new Float32Array([0.2, -0.2, 0.5])];
    const once = renderChannels(source, 3 / 10, { gain: 2, fadeIn: 0, fadeOut: 0 });
    const twiceFromSource = renderChannels(source, 3 / 10, { gain: 2, fadeIn: 0, fadeOut: 0 });
    expect(Array.from(twiceFromSource[0]!)).toEqual(Array.from(once[0]!));
    expect(once[0]![0]).toBeCloseTo(0.4, 5);
    expect(once[0]![1]).toBeCloseTo(-0.4, 5);
    expect(once[0]![2]).toBe(1);
    // 输入源本身不被修改
    expect(Array.from(source[0]!)).toEqual([0.2, -0.2, 0.5]);
  });
  it('starts at silence for fade-in and fades out at the tail', () => {
    const sampleRate = 100;
    const duration = 1;
    const source = [Float32Array.from({ length: sampleRate }, () => 1)];
    const out = renderChannels(source, duration, { gain: 1, fadeIn: 0.2, fadeOut: 0.3 })[0]!;
    expect(out[0]).toBe(0);
    // 最后一个样本位于 0.99s，处于淡出斜坡末端，电平应接近静默（包络在 1.0s 处归零）
    expect(out[sampleRate - 1]!).toBeLessThan(0.01);
    // 淡化区之外保持单位增益
    expect(out[50]).toBeCloseTo(1, 3);
  });
  it('keeps fades inside the clip even when parameters overflow', () => {
    const sampleRate = 100;
    const duration = 1;
    const source = [Float32Array.from({ length: sampleRate }, () => 1)];
    const out = renderChannels(source, duration, { gain: 1, fadeIn: 8, fadeOut: 8 })[0]!;
    expect(out[0]).toBe(0);
    expect(out[sampleRate - 1]!).toBeLessThan(0.01);
    // 淡化合计不超过片段：中点不应被压成 0
    expect(out[50]).toBeGreaterThan(0.9);
  });
});

describe('audio-dsp detectClipping', () => {
  it('reports no clipping below the 16-bit ceiling', () => {
    expect(detectClipping([new Float32Array([PCM16_CEILING - 0.001])]).clipped).toBe(false);
  });
  it('makes a single over-ceiling sample noticeable', () => {
    const report = detectClipping([new Float32Array([0.1, PCM16_CEILING + 0.001, 0.2])]);
    expect(report.clipped).toBe(true);
    expect(report.eventCount).toBe(1);
    expect(report.peak).toBeGreaterThan(PCM16_CEILING);
  });
});
