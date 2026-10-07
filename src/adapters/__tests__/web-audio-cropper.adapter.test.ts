import { describe, expect, it } from 'vitest';
import { WebAudioCropperAdapter, type DecodedAudio } from '../web-audio-cropper.adapter';
import { WebAudioAnalyzerAdapter } from '../web-audio-analyzer.adapter';

const decoded = (duration = 12): DecodedAudio => ({ sampleRate: 10, duration, channels: [Float32Array.from({ length: duration * 10 }, (_, index) => index % 5 ? .4 : 0)] });

describe('WebAudioCropperAdapter', () => {
  it('marks imports over ten seconds as requiring crop', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    expect(await adapter.inspect(new Blob())).toEqual({ duration: 12, needsCrop: true });
  });
  it('caps encoded output range at ten seconds', async () => {
    const adapter = new WebAudioCropperAdapter({ decode: async () => decoded(12) });
    const result = await adapter.crop(new Blob(), { start: 1, end: 11 });
    expect(result.duration).toBe(10);
    expect(result.blob.type).toBe('audio/wav');
  });
  it('processes gain from the retained slice and reports clipping with fingerprint', async () => {
    // 样本 0.4 持续出现，2.5 倍增益后必削波
    const audio: DecodedAudio = { sampleRate: 100, duration: 2, channels: [Float32Array.from({ length: 200 }, () => 0.4)] };
    const adapter = new WebAudioCropperAdapter({ decode: async () => audio });
    const result = await adapter.process(new Blob(['src']), { start: 0, end: 2 }, { gain: 2.5, fadeIn: 0, fadeOut: 0 }, 7);
    expect(result.duration).toBe(2);
    expect(result.clipped).toBe(true);
    expect(result.peak).toBeCloseTo(1, 1);
    expect(result.fingerprint).toMatchObject({ sourceStart: 0, sourceEnd: 2, generation: 7 });
    expect(result.fingerprint.settings).toEqual({ gain: 2.5, fadeIn: 0, fadeOut: 0 });
  });
  it('clamps oversized fades to the slice during processing', async () => {
    const audio: DecodedAudio = { sampleRate: 100, duration: 1, channels: [Float32Array.from({ length: 100 }, () => 0.2)] };
    const adapter = new WebAudioCropperAdapter({ decode: async () => audio });
    const result = await adapter.process(new Blob(), { start: 0, end: 1 }, { gain: 1, fadeIn: 6, fadeOut: 6 }, 1);
    // 不抛错即说明淡化被钳制在片段内；指纹记录用户提交值，实际渲染由 DSP 钳制
    expect(result.duration).toBe(1);
    expect(result.clipped).toBe(false);
  });
});

describe('WebAudioAnalyzerAdapter', () => {
  it('extracts finite normalized features and duration', async () => {
    const result = await new WebAudioAnalyzerAdapter({ decode: async () => decoded(2) }).analyze(new Blob());
    expect(result.duration).toBe(2);
    expect(Object.values(result.features).every(Number.isFinite)).toBe(true);
  });
});
