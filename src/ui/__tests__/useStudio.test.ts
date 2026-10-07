import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import { applyEffects, type PcmSource } from '../../core/audio-effects';
import type { VoiceMeme } from '../../core/models';

function pcmFromBlob(blob: Blob): import('../../ports/audio-effects.port').PcmAudio {
  const duration = blob.size === 2 ? 2 : 1;
  const channels = [Float32Array.from({ length: duration * 10 }, (_, i) => (i % 5 ? 0.8 : 0))];
  return { sampleRate: 10, duration, channels, peak: 0.8 };
}

function effectsPort() {
  return {
    decode: async (blob: Blob) => pcmFromBlob(blob),
    render: (source: PcmSource, params: import('../../core/audio-effects').AudioEffectParams) => applyEffects(source, params),
    encode: () => new Blob(['fx'], { type: 'audio/wav' }),
    play: async () => ({ stop() {}, done: Promise.resolve() }),
  };
}

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob: new Blob([blob, `${range.end - range.start}`]),duration:range.end-range.start}) },
    effects: effectsPort(),
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

const tick = () => Promise.resolve();

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });

  it('adjusts effects on the retained segment, analyzes the committed audio, and blocks saving after a later tweak', async () => {
    const analyzedBlobs: Blob[] = [];
    const deps = dependencies({ analyzer: { analyze: async (blob) => { analyzedBlobs.push(blob); return { duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }; } } });
    const studio = useStudio(deps);
    await studio.startRecording(); await studio.stopRecording();

    await studio.enterAdjust();
    expect(studio.adjustMode.value).toBe(true);
    expect(studio.draft.segmentBlob).toBeInstanceOf(Blob);
    studio.preview.update({ gain: 1.6, fadeOut: 0.4 });
    await studio.runAnalysis();
    expect(studio.stage.value).toBe('emotion');
    // 分析用的正是这次确认产生的成品
    expect(analyzedBlobs[0]).toBe(studio.draft.audio);

    studio.selectEmotion('元气满满'); studio.goCover();
    // 确认后又拖了滑块：没有重新采用时保存必须被拒绝
    studio.preview.update({ gain: 1.9 });
    await studio.save();
    expect(studio.error.value).toContain('重新“采用效果并分析”');
    expect(studio.draft.audio).toBe(analyzedBlobs[0]);

    // 重新采用并分析后，保存恢复且保存的是新参数的音频
    await studio.runAnalysis();
    studio.goCover();
    await studio.save();
    expect(studio.stage.value).toBe('collection');
    expect(studio.draft.audio).not.toBe(analyzedBlobs[0]);
  });

  it('keeps segment, sliders and committed audio recoverable when analysis fails', async () => {
    const deps = dependencies({ analyzer: { analyze: async () => { throw new Error('decode boom'); } } });
    const studio = useStudio(deps);
    await studio.startRecording(); await studio.stopRecording();
    await studio.enterAdjust();
    studio.preview.update({ gain: 1.3, fadeIn: 0.2 });
    await studio.runAnalysis();
    expect(studio.error.value).toContain('decode boom');
    expect(studio.stage.value).toBe('crop');
    expect(studio.draft.segmentBlob).toBeInstanceOf(Blob);
    expect(studio.preview.params.value.gain).toBeCloseTo(1.3);
  });

  it('re-anchors processing to a new retained segment when the crop range changes', async () => {
    const studio = useStudio(dependencies());
    await studio.startRecording(); await studio.stopRecording();
    await studio.enterAdjust();
    studio.preview.update({ gain: 1.8 });
    expect(studio.preview.clippingPredicted.value).toBe(true);
    studio.backToCrop();
    // 用户改了裁剪起点：保留片段失效，必须重新裁剪后才允许分析
    studio.draft.segmentBlob = undefined; studio.adjustMode.value = false; studio.draft.cropStart = 0.5;
    await studio.analyze();
    expect(studio.stage.value).toBe('emotion');
    expect(studio.draft.cropStart).toBe(0.5);
  });
});
