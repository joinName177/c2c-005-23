import { computed, ref } from 'vue';
import {
  clampEffectParams,
  predictsClipping,
  sameParams,
  DEFAULT_EFFECT_PARAMS,
  type AudioEffectParams,
  type EffectRenderResult,
} from '../core/audio-effects';
import type { AudioEffectsPort, PcmAudio, PlaybackHandle } from '../ports/audio-effects.port';

/**
 * 可取消的定时器抽象。生产环境用 setTimeout；测试注入手动排程器，
 * 使“快速拖动 → 合并 → 只处理最后一次”的行为可以确定性验证。
 */
export interface PreviewScheduler {
  schedule(callback: () => void, delay: number): number;
  cancel(handle: number): void;
}

const defaultScheduler: PreviewScheduler = {
  schedule: (callback, delay) => setTimeout(callback, delay) as unknown as number,
  cancel: (handle) => clearTimeout(handle),
};

/**
 * 三级处理分工：
 * - 拖动中（Tier A，零成本）：只更新滑块参数与“原峰值 × 增益”的削波预判，不做任何渲染。
 * - 停顿后（Tier B，较轻）：合并在途与等待中的请求，最多 1 个在途 + 1 个待执行，
 *   世代令牌过期的结果直接丢弃；渲染只写内存，不编码、不落盘。
 * - 点“采用效果”（Tier C，重）：以保留片段为基准做一次权威渲染并同步编码 WAV，
 *   情绪分析与保存只接受这次确认产生的 Blob。
 */
export function useAudioPreview(
  effects: AudioEffectsPort,
  scheduler: PreviewScheduler = defaultScheduler,
  /** 在途窗口的等待点；测试可注入可手动放行的闸门以确定性地插入并发更新。 */
  defer: () => Promise<void> = () => Promise.resolve(),
) {
  const source = ref<PcmAudio>();
  const sourceKey = ref(0);
  const params = ref<AudioEffectParams>({ ...DEFAULT_EFFECT_PARAMS });
  const preview = ref<EffectRenderResult>();
  const previewKey = ref(0);
  const processing = ref(false);
  const previewError = ref('');
  const playing = ref(false);
  const committed = ref<{ params: AudioEffectParams; blob: Blob; token: number }>();
  /** 编辑已保存旧作品：音频本就是成品，保存时豁免“参数与音频同源”校验 */
  const legacy = ref(false);

  let generation = 0;
  let timer: number | undefined;
  let inFlight = false;
  /** 唯一的待执行槽；latestParams 始终保留最后一次拖动的参数，latest 标记是否仍为最新世代。 */
  let queued: { latest: boolean; params: AudioEffectParams } | undefined;
  let playback: PlaybackHandle | undefined;

  const effectiveDuration = computed(() => source.value?.duration ?? 0);
  const isCommitted = computed(() => committed.value !== undefined && sameParams(committed.value.params, params.value));
  /** 已采用后又改了参数：试听与滑块是新的，已确认 Blob 是旧的，必须显式重新采用 */
  const dirtyAfterCommit = computed(() => committed.value !== undefined && !sameParams(committed.value.params, params.value));
  const clippingPredicted = computed(() => source.value !== undefined && predictsClipping(source.value.peak, params.value.gain));
  const clippingConfirmed = computed(() => (preview.value?.rawPeak ?? 0) > 1);
  const clippedRatio = computed(() => {
    if (!preview.value || preview.value.totalSamples === 0) return 0;
    return preview.value.clippedSamples / preview.value.totalSamples;
  });

  function stopPlayback() {
    playback?.stop();
    playback = undefined;
    playing.value = false;
  }

  /** 重新裁剪或进入新片段时调用：旧世代全部作废，保留片段成为新的唯一基准。 */
  function attach(nextSource: PcmAudio) {
    stopPlayback();
    generation += 1;
    if (timer !== undefined) scheduler.cancel(timer);
    timer = undefined;
    inFlight = false;
    queued = undefined;
    source.value = nextSource;
    sourceKey.value += 1;
    params.value = { ...DEFAULT_EFFECT_PARAMS };
    preview.value = undefined;
    previewKey.value = 0;
    previewError.value = '';
    committed.value = undefined;
    legacy.value = false;
    processing.value = false;
  }

  function detach() {
    stopPlayback();
    generation += 1;
    if (timer !== undefined) scheduler.cancel(timer);
    timer = undefined;
    inFlight = false;
    queued = undefined;
    source.value = undefined;
    preview.value = undefined;
    committed.value = undefined;
    legacy.value = false;
    processing.value = false;
    previewError.value = '';
  }

  function resetParams() {
    update({ ...DEFAULT_EFFECT_PARAMS });
  }

  function update(patch: Partial<AudioEffectParams>) {
    if (!source.value) throw new Error('尚未载入可处理的片段');
    generation += 1;
    if (timer !== undefined) scheduler.cancel(timer);
    stopPlayback();
    // 时长夹取：淡入淡出之和不得超过片段长度（run 渲染前 clampEffectParams 再兜底一次）。
    params.value = clampEffectParams({ ...params.value, ...patch }, source.value.duration);
    // 停顿 120ms 后再做较重处理；快速拖动时反复重置，只有最后一次会真正执行。
    timer = scheduler.schedule(() => {
      timer = undefined;
      enqueue(generation, { ...params.value });
    }, 120);
  }

  function enqueue(generationAtSchedule: number, requested: AudioEffectParams) {
    if (!source.value) return;
    if (inFlight) {
      // 在途只有一个，后到的拖动合并进唯一的待执行槽，旧参数被直接覆盖取消。
      // 是否“最新”以当前世代为准，避免在途结束时把仍有效的排队结果误判为过期。
      queued = { latest: generationAtSchedule === generation, params: requested };
      return;
    }
    void run(generationAtSchedule, requested);
  }

  async function run(generationAtSchedule: number, requested: AudioEffectParams) {
    if (!source.value) return;
    const current = source.value;
    inFlight = true;
    processing.value = true;
    previewError.value = '';
    // 渲染是同步纯计算，先让出一个在途窗口（生产环境为微任务），使旧结果晚返回时能被世代令牌拦截；
    // 编码与解码这类重活不参与试听路径。
    try {
      await defer();
      if (generationAtSchedule !== generation || !source.value || source.value !== current) {
        // 旧世代晚返回：结果丢弃，但必须释放在途槽并转交唯一的待执行任务，否则会积压/死锁。
        inFlight = false;
        const stalePending = queued;
        queued = undefined;
        if (stalePending && source.value) {
          // 排队任务以最新世代重新执行；latest=false 说明排队期间又有新拖动，
          // 那时它的定时器会另行处理，这里只需让出槽位即可。
          if (stalePending.latest) {
            if (timer !== undefined) { scheduler.cancel(timer); timer = undefined; }
            void run(generation, stalePending.params);
          } else {
            processing.value = false;
          }
        } else {
          processing.value = false;
        }
        return;
      }
      const result = effects.render(current, requested);
      preview.value = result;
      previewKey.value = generationAtSchedule;
      inFlight = false;
      const pending = queued;
      queued = undefined;
      if (pending && pending.latest && source.value === current) {
        // 承接排队任务：它携带的参数与待触发的停顿定时器相同，取消后者避免多渲染一次。
        if (timer !== undefined) { scheduler.cancel(timer); timer = undefined; }
        void run(generation, pending.params); // 处理态延续，直到排队任务也结束
      } else {
        processing.value = false;
      }
    } catch {
      // 无论世代是否过期都要释放槽位；只有仍是当前世代时才展示错误。
      inFlight = false;
      queued = undefined;
      processing.value = false;
      if (generationAtSchedule === generation) previewError.value = '试听处理失败，原片段与当前参数仍保留，可重试';
    }
  }

  /** 测试与“立即试听”入口：跳过停顿合并，马上渲染当前参数。 */
  function flush() {
    if (!source.value) return;
    if (timer !== undefined) { scheduler.cancel(timer); timer = undefined; }
    enqueue(generation, { ...params.value });
  }

  async function previewOriginal() {
    if (!source.value) return;
    stopPlayback();
    playback = await effects.play(source.value);
    playing.value = true;
    playback.done.finally(() => { playing.value = false; playback = undefined; });
  }

  async function previewProcessed() {
    if (!source.value) return;
    const current = source.value;
    const currentGeneration = generation;
    // 试听的永远是当前滑块对应的处理结果，直接以保留片段渲染，不等待在途任务。
    const result = effects.render(current, { ...params.value });
    preview.value = result;
    previewKey.value = currentGeneration;
    stopPlayback();
    playback = await effects.play(result);
    playing.value = true;
    playback.done.finally(() => { playing.value = false; playback = undefined; });
  }

  /**
   * 确认采用（Tier C）：以保留片段为基准做权威渲染并编码。
   * 返回的 token 与世代、参数、源片段严格绑定，调用方保存时必须再次核对，
   * 防止“较早参数的音频 + 最新参数”被一起保存。
   */
  function commit(): { blob: Blob; params: AudioEffectParams; sourceKey: number; token: number } {
    if (!source.value) throw new Error('尚未载入可处理的片段');
    const safe = clampEffectParams(params.value, source.value.duration);
    params.value = safe;
    const result = effects.render(source.value, safe);
    const blob = effects.encode(result);
    const token = generation;
    committed.value = { params: { ...safe }, blob, token };
    preview.value = result;
    previewKey.value = token;
    return { blob, params: { ...safe }, sourceKey: sourceKey.value, token };
  }

  /** 编辑旧作品时音频已经是成品，登记为“已采用”，但保存时走旧作品豁免校验。 */
  function markLegacy(blob: Blob) {
    legacy.value = true;
    committed.value = { params: { ...DEFAULT_EFFECT_PARAMS }, blob, token: 0 };
  }

  return {
    params,
    preview,
    previewKey,
    processing,
    previewError,
    playing,
    legacy,
    effectiveDuration,
    isCommitted,
    dirtyAfterCommit,
    clippingPredicted,
    clippingConfirmed,
    clippedRatio,
    attach,
    detach,
    resetParams,
    update,
    flush,
    stopPlayback,
    previewOriginal,
    previewProcessed,
    commit,
    markLegacy,
  };
}
