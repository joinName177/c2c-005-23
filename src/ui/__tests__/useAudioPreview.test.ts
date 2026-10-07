import { describe, expect, it } from 'vitest';
import { useAudioPreview, type PreviewScheduler } from '../useAudioPreview';
import { applyEffects, type EffectRenderResult } from '../../core/audio-effects';
import type { AudioEffectsPort, PcmAudio, PlaybackHandle } from '../../ports/audio-effects.port';

const pcm = (overrides: Partial<PcmAudio> = {}): PcmAudio => ({
  sampleRate: 10,
  duration: 2,
  channels: [Float32Array.from({ length: 20 }, () => 0.5)],
  peak: 0.5,
  ...overrides,
});

class ManualScheduler implements PreviewScheduler {
  callbacks = new Map<number, () => void>();
  nextHandle = 1;
  schedule(callback: () => void) { const handle = this.nextHandle; this.nextHandle += 1; this.callbacks.set(handle, callback); return handle; }
  cancel(handle: number) { this.callbacks.delete(handle); }
  fire() { const [callback] = [...this.callbacks.values()]; this.callbacks.clear(); callback?.(); }
  get pending() { return this.callbacks.size; }
}

function effectsPort(): { port: AudioEffectsPort; renders: AudioEffectParamsLike[]; plays: unknown[]; encoded: unknown[] } {
  const renders: AudioEffectParamsLike[] = [];
  const plays: unknown[] = [];
  const encoded: unknown[] = [];
  const port: AudioEffectsPort = {
    decode: async () => ({ ...pcm() }),
    render: (source, params) => {
      // 渲染是同步纯计算；控制器用 await Promise.resolve() 制造在途窗口。
      renders.push({ ...params });
      return applyEffects(source, params);
    },
    encode: (rendered: EffectRenderResult) => { const blob = new Blob([rendered.peak.toFixed(3)]); encoded.push(blob); return blob; },
    play: async (source) => { plays.push(source); return { stop() {}, done: Promise.resolve() } satisfies PlaybackHandle; },
  };
  return { port, renders, plays, encoded };
}

type AudioEffectParamsLike = { gain: number; fadeIn: number; fadeOut: number };

function tick() { return Promise.resolve(); }

describe('useAudioPreview scheduling', () => {
  it('does nothing while dragging and coalesces rapid updates into one trailing render', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm());

    preview.update({ gain: 1.1 });
    preview.update({ gain: 1.2 });
    preview.update({ gain: 1.3 });
    expect(scheduler.pending).toBe(1); // 反复重排，只有最后一个定时器存活
    expect(kit.renders).toHaveLength(0); // 拖动中不做较重处理
    expect(preview.clippingPredicted.value).toBe(false);

    scheduler.fire();
    await tick();
    expect(kit.renders).toEqual([{ gain: 1.3, fadeIn: 0, fadeOut: 0 }]);
    expect(preview.preview.value?.peak).toBeCloseTo(0.65);
  });

  it('discards a stale render result that returns after a newer update', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm());

    preview.update({ gain: 1.5 });
    scheduler.fire(); // 触发第一次渲染进入在途（世代 1）
    preview.update({ gain: 1.8 }); // 世代 +1，第一次结果作废
    await tick(); // 第一次渲染返回（过期，必须被丢弃）
    expect(preview.previewKey.value).toBe(0); // 旧结果没有被采纳
    scheduler.fire();
    await tick();
    expect(preview.previewKey.value).toBe(3);
    expect(preview.preview.value?.peak).toBeCloseTo(0.9);
  });

  it('merges into a single queued slot while a render is in flight', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    let release: () => void = () => {};
    let gatePromise: Promise<void> | undefined;
    const gate = () => {
      // 只拦截第一次（在途）渲染；排队渲染放行后立即继续。
      if (!gatePromise) gatePromise = new Promise<void>((resolve) => { release = resolve; });
      return gatePromise;
    };
    const preview = useAudioPreview(kit.port, scheduler, gate);
    preview.attach(pcm());

    preview.update({ gain: 1.2 });
    scheduler.fire(); // 在途渲染 1，停在闸门处
    // 闸门未放行：三次更新只有最后一次的参数会经过排队槽。
    preview.update({ gain: 1.4 });
    scheduler.fire(); // 在途中 → 入排队槽
    preview.update({ gain: 1.6 });
    scheduler.fire(); // 覆盖排队槽
    preview.update({ gain: 1.8 });
    scheduler.fire(); // 再次覆盖排队槽
    release(); // 放行在途渲染 1：其世代已过期，连渲染本身都被取消
    await tick();
    await tick(); // 排队渲染完成
    expect(kit.renders).toEqual([
      // 1.2 的在途渲染被取消（renders 中没有它），只执行最新排队参数 1.8
      { gain: 1.8, fadeIn: 0, fadeOut: 0 },
    ]);
  });

  it('invalidates every pending generation when a new source is attached', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm());
    preview.update({ gain: 1.7 });
    preview.attach(pcm({ peak: 0.2 })); // 重新裁剪
    expect(scheduler.pending).toBe(0);
    expect(preview.params.value.gain).toBe(1);
    expect(preview.preview.value).toBeUndefined();
  });

  it('commits an authoritative render + encode from the retained source and flags later edits dirty', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm());
    preview.update({ gain: 1.4, fadeOut: 0.3 });

    const committed = preview.commit();
    expect(committed.params).toEqual({ gain: 1.4, fadeIn: 0, fadeOut: 0.3 });
    expect(preview.isCommitted.value).toBe(true);
    expect(committed.blob).toBeInstanceOf(Blob);

    preview.update({ gain: 1.9 });
    expect(preview.dirtyAfterCommit.value).toBe(true);
    expect(preview.isCommitted.value).toBe(false);

    const recommitted = preview.commit();
    expect(preview.dirtyAfterCommit.value).toBe(false);
    expect(recommitted.blob).not.toBe(committed.blob);
  });

  it('shows predicted clipping during drag and measured clipping after the settled render', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm({ peak: 0.8, channels: [Float32Array.from({ length: 20 }, () => 0.8)] }));
    preview.update({ gain: 2 });
    expect(preview.clippingPredicted.value).toBe(true);
    expect(preview.clippingConfirmed.value).toBe(false);
    scheduler.fire();
    await tick();
    expect(preview.clippingConfirmed.value).toBe(true);
    expect(preview.clippedRatio.value).toBeGreaterThan(0);
  });

  it('replays the processed result immediately from the current sliders', async () => {
    const scheduler = new ManualScheduler();
    const kit = effectsPort();
    const preview = useAudioPreview(kit.port, scheduler);
    preview.attach(pcm());
    preview.update({ gain: 1.5 });
    await preview.previewProcessed();
    const played = kit.plays[0] as EffectRenderResult;
    expect(played.peak).toBeCloseTo(0.75);
  });
});
