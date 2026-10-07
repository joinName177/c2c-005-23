import { describe, expect, it } from 'vitest';
import { WebAudioEffectsAdapter, encodeWav } from '../web-audio-effects.adapter';
import type { PcmAudio } from '../../ports/audio-effects.port';

const pcm = (channels: number[][]): PcmAudio => ({
  sampleRate: 100,
  duration: (channels[0]?.length ?? 0) / 100,
  channels: channels.map((c) => Float32Array.from(c)),
  peak: 0,
});

describe('WebAudioEffectsAdapter', () => {
  it('decodes peak from channels', async () => {
    const adapter = new WebAudioEffectsAdapter({ decodeAudioBlob: async () => ({ sampleRate: 8, duration: 0.5, channels: [Float32Array.from([0.2, -0.9, 0.5])] }) });
    const decoded = await adapter.decode(new Blob());
    expect(decoded.peak).toBeCloseTo(0.9);
  });

  it('renders effects through the pure core and reports clipping', () => {
    const adapter = new WebAudioEffectsAdapter();
    const result = adapter.render(pcm([[0.5, 0.8, 0.4]]), { gain: 1.5, fadeIn: 0, fadeOut: 0 });
    const values = Array.from(result.channels[0]);
    expect(values[0]).toBeCloseTo(0.75);
    expect(values[1]).toBe(1);
    expect(values[2]).toBeCloseTo(0.6);
    expect(result.clippedSamples).toBe(1);
  });

  it('encodes 44-byte-header WAV and hard-limits at full scale', () => {
    const blob = encodeWav({ sampleRate: 100, channels: [Float32Array.from([2, -2, 0])] });
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 3 * 2);
  });
});
