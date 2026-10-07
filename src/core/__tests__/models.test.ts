import { describe, expect, it } from 'vitest';
import { clampFades, validateCropRange, validateTuneSettings } from '../models';

describe('validateCropRange', () => {
  it('rejects a negative start', () => expect(validateCropRange({ start: -1, end: 3 }, 5)).toContain('起点'));
  it('rejects reversed endpoints', () => expect(validateCropRange({ start: 4, end: 2 }, 5)).toContain('终点'));
  it('rejects clips longer than ten seconds', () => expect(validateCropRange({ start: 0, end: 11 }, 12)).toContain('10 秒'));
  it('accepts an exact ten-second clip', () => expect(validateCropRange({ start: 0, end: 10 }, 10)).toBeUndefined());
});

describe('clampFades', () => {
  it('caps each fade at half the clip', () => {
    expect(clampFades(8, 0, 2)).toEqual({ fadeIn: 1, fadeOut: 0 });
    expect(clampFades(0, 9, 2)).toEqual({ fadeIn: 0, fadeOut: 1 });
  });
  it('scales both fades down when together they exceed the clip', () => {
    const result = clampFades(4, 4, 2);
    expect(result.fadeIn + result.fadeOut).toBeCloseTo(2);
    expect(result.fadeIn).toBeCloseTo(1);
    expect(result.fadeOut).toBeCloseTo(1);
  });
  it('treats non-finite input as zero', () => {
    expect(clampFades(Number.NaN, Number.POSITIVE_INFINITY, 2)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });
});

describe('validateTuneSettings', () => {
  it('requires positive finite gain', () => {
    expect(validateTuneSettings({ gain: 0, fadeIn: 0, fadeOut: 0 }, 2)).toContain('音量');
    expect(validateTuneSettings({ gain: Number.NaN, fadeIn: 0, fadeOut: 0 }, 2)).toContain('音量');
  });
  it('rejects negative fades', () => {
    expect(validateTuneSettings({ gain: 1, fadeIn: -0.1, fadeOut: 0 }, 2)).toContain('淡化');
  });
  it('accepts in-range settings', () => {
    expect(validateTuneSettings({ gain: 2.4, fadeIn: 0.3, fadeOut: 0.5 }, 2)).toBeUndefined();
  });
});
