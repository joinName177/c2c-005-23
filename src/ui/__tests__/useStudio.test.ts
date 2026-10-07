import { describe, expect, it, vi } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { ProcessedAudio } from '../../ports/audio-cropper.port';
import type { TuneSettings, VoiceMeme } from '../../core/models';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: {
      inspect: async () => ({duration:2,needsCrop:false}),
      crop: async (blob, range) => ({blob,duration:range.end-range.start}),
      process: async (blob, range, settings, generation): Promise<ProcessedAudio> => ({ blob: new Blob(['tuned']), duration: range.end - range.start, peak: settings.gain * .5, clipped: false, eventCount: 0, fingerprint: { sourceStart: range.start, sourceEnd: range.end, settings: { ...settings }, generation } }),
    },
    preview: { cancel: () => {}, preview: vi.fn(async () => ({ stop: () => {} })) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => 'shared' },
    ...overrides,
  };
}

async function startStopTune(studio: ReturnType<typeof useStudio>) {
  await studio.startRecording();
  await studio.stopRecording();
  studio.goTune();
}
async function prepareTunedStudio(overrides: Partial<StudioDependencies> = {}) {
  const studio = useStudio(dependencies(overrides));
  await startStopTune(studio);
  await studio.applyTune();
  return studio;
}

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through tune, apply, emotion with manual override', async () => {
    const studio = await prepareTunedStudio();
    expect(studio.stage.value).toBe('tune');
    expect(studio.adoptedInSync()).toBe(true);
    await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('always renders tuning from the retained source, never accumulating on processed audio', async () => {
    const process = vi.fn(async (_blob: Blob, range: { start: number; end: number }, settings: TuneSettings, generation: number): Promise<ProcessedAudio> =>
      ({ blob: new Blob([`g${settings.gain}`]), duration: range.end - range.start, peak: .5, clipped: false, eventCount: 0, fingerprint: { sourceStart: range.start, sourceEnd: range.end, settings: { ...settings }, generation } }));
    const studio = useStudio(dependencies({ cropper: { inspect: async () => ({ duration: 2, needsCrop: false }), crop: async (b, r) => ({ blob: b, duration: r.end - r.start }), process } }));
    await startStopTune(studio);
    studio.updateGain(2);
    expect(studio.tuningDirty.value).toBe(true);
    await studio.applyTune();
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]![2]).toEqual({ gain: 2, fadeIn: 0, fadeOut: 0 });
    studio.updateGain(1.5);
    await studio.applyTune();
    expect(process).toHaveBeenCalledTimes(2);
    // 第二次渲染的输入与第一次是同一个保留原片段，参数是绝对值而非叠加值
    expect(process.mock.calls[1]![0]).toBe(process.mock.calls[0]![0]);
    expect(process.mock.calls[1]![2]).toEqual({ gain: 1.5, fadeIn: 0, fadeOut: 0 });
  });
  it('refuses analysis before the latest settings are adopted', async () => {
    const studio = useStudio(dependencies());
    await startStopTune(studio);
    await studio.analyze();
    expect(studio.error.value).toContain('采用');
    await studio.applyTune();
    studio.updateFadeIn(0.5);
    await studio.analyze();
    expect(studio.error.value).toContain('采用');
    expect(studio.stage.value).toBe('tune');
  });
  it('discards a late process result when parameters changed mid-flight', async () => {
    let release: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => { release = resolve; });
    const process = vi.fn(async (_blob: Blob, range: { start: number; end: number }, settings: TuneSettings, generation: number): Promise<ProcessedAudio> => {
      await inFlight;
      return { blob: new Blob(['old']), duration: range.end - range.start, peak: 1, clipped: false, eventCount: 0, fingerprint: { sourceStart: range.start, sourceEnd: range.end, settings: { ...settings }, generation } };
    });
    const studio = useStudio(dependencies({ cropper: { inspect: async () => ({ duration: 2, needsCrop: false }), crop: async (b, r) => ({ blob: b, duration: r.end - r.start }), process } }));
    await startStopTune(studio);
    studio.updateGain(2);
    const firstApply = studio.applyTune();
    await Promise.resolve();
    studio.updateGain(1.2); // 旧处理尚未返回时快速拖动
    release!();
    await firstApply;
    expect(studio.adoptedInSync()).toBe(false);
    expect(studio.draft.audio).toBeUndefined();
    expect(studio.notice.value).toContain('采用');
  });
  it('surfaces audible clipping from the adopted render', async () => {
    const studio = useStudio(dependencies({ cropper: { inspect: async () => ({ duration: 2, needsCrop: false }), crop: async (b, r) => ({ blob: b, duration: r.end - r.start }), process: async (blob, range, settings, generation): Promise<ProcessedAudio> => ({ blob, duration: range.end - range.start, peak: 1.2, clipped: true, eventCount: 42, fingerprint: { sourceStart: range.start, sourceEnd: range.end, settings: { ...settings }, generation } }) } }));
    await startStopTune(studio);
    studio.updateGain(3);
    await studio.applyTune();
    expect(studio.clipWarning.value).toContain('削波');
    // 削波不阻断流程，但采用状态依然与参数对应
    expect(studio.adoptedInSync()).toBe(true);
  });
  it('keeps the source and draft when saving fails and keeps edited work in sync', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    await prepareTunedStudioEntry(studio);
    studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save();
    expect(studio.error.value).toContain('保存失败');
    expect(studio.draft.source).toBeDefined();
    expect(studio.draft.audio).toBeDefined();
    expect(studio.adoptedInSync()).toBe(true);
    const existing: VoiceMeme = { id:'old',title:'旧作品',emotion:'温柔姐姐',confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
    expect(studio.adoptedInSync()).toBe(true);
  });
});

async function prepareTunedStudioEntry(studio: ReturnType<typeof useStudio>) {
  await startStopTune(studio);
  await studio.applyTune();
  await studio.analyze();
  studio.goCover();
}
