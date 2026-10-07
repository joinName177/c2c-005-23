import { describe, expect, it, vi } from 'vitest';
import { WebAudioPreviewAdapter } from '../web-audio-preview.adapter';

interface FakeNode { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; onended: (() => void) | null; buffer?: unknown }
interface FakeParam { setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> }

function makeContext() {
  let time = 10;
  const sources: FakeNode[] = [];
  const gainParam: FakeParam = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
  const gainNode = { gain: gainParam, connect: vi.fn(() => destination), disconnect: vi.fn() };
  const destination = {};
  const context = {
    currentTime: time,
    destination,
    createBufferSource: () => {
      const node: FakeNode = { connect: vi.fn(() => gainNode), disconnect: vi.fn(), stop: vi.fn(), start: vi.fn(), onended: null };
      sources.push(node);
      return node;
    },
    createGain: () => gainNode,
    tick: (seconds: number) => { time += seconds; context.currentTime = time; },
    _sources: sources,
    _gainParam: gainParam,
    _gainNode: gainNode,
  };
  return context;
}

function buffer(duration: number) {
  return { duration } as unknown as AudioBuffer;
}

describe('WebAudioPreviewAdapter', () => {
  it('starts a source with gain and fade automation', async () => {
    const ctx = makeContext();
    const adapter = new WebAudioPreviewAdapter({
      context: ctx as unknown as AudioContext,
      decode: vi.fn(async () => buffer(2)),
      now: () => ctx.currentTime,
    });
    await adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1.5, fadeIn: 0.2, fadeOut: 0.4 });
    const source = ctx._sources[0]!;
    expect(source.start).toHaveBeenCalledTimes(1);
    // 起点、时长按裁剪范围传入播放源
    expect(source.start.mock.calls[0]!.slice(1)).toEqual([expect.any(Number), 0, 2]);
    expect(ctx._gainParam.linearRampToValueAtTime).toHaveBeenCalledWith(1.5, expect.any(Number));
  });
  it('cancels the previous playback when a newer preview starts', async () => {
    const ctx = makeContext();
    const adapter = new WebAudioPreviewAdapter({
      context: ctx as unknown as AudioContext,
      decode: vi.fn(async () => buffer(2)),
      now: () => ctx.currentTime,
    });
    await adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1, fadeIn: 0, fadeOut: 0 });
    const first = ctx._sources[0]!;
    await adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1.2, fadeIn: 0, fadeOut: 0 });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(ctx._sources).toHaveLength(2);
  });
  it('drops a decode result that arrives after newer parameters', async () => {
    const ctx = makeContext();
    let releaseFirst: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const decode = vi.fn()
      .mockImplementationOnce(() => slow.then(() => buffer(2)))
      .mockImplementationOnce(async () => buffer(2));
    const adapter = new WebAudioPreviewAdapter({ context: ctx as unknown as AudioContext, decode, now: () => ctx.currentTime });
    const stale = adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1, fadeIn: 0, fadeOut: 0 });
    const fresh = adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1.2, fadeIn: 0, fadeOut: 0 });
    releaseFirst!();
    await Promise.all([stale, fresh]);
    // 只有新参数真正接线播放，旧解码晚返回不产生声音
    expect(ctx._sources).toHaveLength(1);
  });
  it('cancel stops the current source', async () => {
    const ctx = makeContext();
    const adapter = new WebAudioPreviewAdapter({ context: ctx as unknown as AudioContext, decode: vi.fn(async () => buffer(2)), now: () => ctx.currentTime });
    await adapter.preview(new Blob(['a']), { start: 0, end: 2 }, { gain: 1, fadeIn: 0, fadeOut: 0 });
    const source = ctx._sources[0]!;
    adapter.cancel();
    expect(source.stop).toHaveBeenCalledTimes(1);
  });
});
