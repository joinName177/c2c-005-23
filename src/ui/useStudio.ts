import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import {
  clampFades,
  defaultTuneSettings,
  sameTuneSettings,
  validateCropRange,
  validateTuneSettings,
  type AudioFeatures,
  type CoverConfig,
  type CropRange,
  type EmotionLabel,
  type EmotionResult,
  type ProcessFingerprint,
  type StudioStage,
  type TuneSettings,
  type VoiceMeme,
} from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { AudioPreviewPort } from '../ports/audio-preview.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; preview: AudioPreviewPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }

// 拖动试听防抖：音量滑块可再短些，淡化参数统一走此间隔
const PREVIEW_DEBOUNCE_MS = 160;

export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{
    id?: string;
    title: string;
    source?: Blob;          // 保留的原始录音/导入文件：所有调音唯一依据，永不被覆盖
    audio?: Blob;           // 已确认采用的处理结果，分析与保存只用它
    duration: number;
    cropStart: number;
    cropEnd: number;
  }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const settings = reactive<TuneSettings>({ ...defaultTuneSettings });
  const processing = ref(false);
  const tuningDirty = ref(false);   // 参数相对已采用结果是否又被改动
  const clipWarning = ref('');      // 已确认渲染中检测到的削波（可察觉提示）
  const previewPeak = ref(0);       // 试听链路估算峰值（拖动时轻量提示）
  const adopted = ref<{ fingerprint: ProcessFingerprint }>();
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  let previewGeneration = 0;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  function resetTune() {
    settings.gain = 1; settings.fadeIn = 0; settings.fadeOut = 0;
    tuningDirty.value = false; clipWarning.value = ''; previewPeak.value = 0; adopted.value = undefined;
  }

  async function openCrop(blob: Blob) {
    draft.source = blob; draft.audio = undefined;
    resetTune();
    const info = await deps.cropper.inspect(blob);
    draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration);
    stage.value = 'crop';
    notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，先裁剪再调音';
  }

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() {
    try { const blob = await deps.recorder.stop(); await openCrop(blob); }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; }
  }
  async function importAudio(blob: Blob) { try { await openCrop(blob); } catch (cause) { error.value = cause instanceof Error ? cause.message : '音频导入失败，请换用浏览器支持的格式。'; } }

  const currentRange = (): CropRange => ({ start: draft.cropStart, end: draft.cropEnd });
  const clipDuration = () => draft.cropEnd - draft.cropStart;

  function goTune() {
    if (!draft.source) { error.value = '请先录制或导入一段声音'; return; }
    const rangeError = validateCropRange(currentRange(), draft.duration);
    if (rangeError) { error.value = rangeError; return; }
    error.value = '';
    resetTune();
    stage.value = 'tune';
  }
  function goCrop() {
    stopPreview();
    resetTune();
    stage.value = 'crop';
  }

  // 拖动过程中：只安排一次防抖后的实时试听；不产生任何离线渲染。
  function schedulePreview() {
    if (stage.value !== 'tune' || !draft.source) return;
    if (previewTimer) clearTimeout(previewTimer);
    const token = ++previewGeneration;
    previewTimer = setTimeout(() => {
      void runPreview(token);
    }, PREVIEW_DEBOUNCE_MS);
  }

  async function runPreview(token: number) {
    if (!draft.source) return;
    const snapshot: TuneSettings = { ...settings };
    const range = currentRange();
    try {
      await deps.preview.preview(draft.source, range, snapshot);
      // 旧的防抖回调晚返回：其试听已被适配器按 generation 作废，这里不再更新任何界面状态。
      if (token !== previewGeneration) return;
      previewPeak.value = estimatePeak(snapshot);
    } catch (cause) {
      if (token === previewGeneration) error.value = cause instanceof Error ? cause.message : '试听失败，请重试';
    }
  }

  // 轻量峰值估算：仅基于增益与淡化形状给拖动期提示，不逐样本计算（逐样本留给确认渲染）。
  function estimatePeak(snapshot: TuneSettings): number {
    return Math.min(1, snapshot.gain);
  }

  function updateGain(value: number) {
    settings.gain = clampGain(value);
    tuningDirty.value = true;
    clipWarning.value = '';
    schedulePreview();
  }
  function updateFadeIn(value: number) {
    settings.fadeIn = clampFades(value, settings.fadeOut, clipDuration()).fadeIn;
    tuningDirty.value = true; clipWarning.value = ''; schedulePreview();
  }
  function updateFadeOut(value: number) {
    settings.fadeOut = clampFades(settings.fadeIn, value, clipDuration()).fadeOut;
    tuningDirty.value = true; clipWarning.value = ''; schedulePreview();
  }
  function clampGain(value: number) { return Math.max(0.2, Math.min(3, Number.isFinite(value) ? value : 1)); }

  function previewOriginal() {
    if (!draft.source) return;
    previewGeneration += 1;
    if (previewTimer) clearTimeout(previewTimer);
    void deps.preview.preview(draft.source, currentRange(), defaultTuneSettings).catch(() => {});
  }
  function previewProcessed() {
    if (!draft.source) return;
    const token = ++previewGeneration;
    if (previewTimer) clearTimeout(previewTimer);
    void runPreview(token);
  }
  function stopPreview() {
    previewGeneration += 1;
    if (previewTimer) clearTimeout(previewTimer);
    deps.preview.cancel();
  }

  /**
   * 确认采用：以保留的原片段 + 最新参数做一次完整离线渲染。
   * 渲染期间若用户又改了参数（generation 前进），晚返回的旧结果必须丢弃，绝不采用。
   */
  async function applyTune() {
    if (!draft.source) { error.value = '缺少原始声音，无法处理'; return; }
    const rangeError = validateCropRange(currentRange(), draft.duration);
    if (rangeError) { error.value = rangeError; return; }
    const duration = clipDuration();
    const snapshot: TuneSettings = { gain: settings.gain, fadeIn: settings.fadeIn, fadeOut: settings.fadeOut };
    const tuneError = validateTuneSettings(snapshot, duration);
    if (tuneError) { error.value = tuneError; return; }
    // 冻结参数代际：此后任何滑块变化都会令 previewGeneration 前进，使本次晚返回结果作废。
    const generation = previewGeneration + 1;
    previewGeneration = generation;
    if (previewTimer) clearTimeout(previewTimer);
    const range = currentRange();
    processing.value = true; error.value = '';
    try {
      const result = await deps.cropper.process(draft.source, range, snapshot, generation);
      // 渲染往返期间参数已变化：旧音频作废，避免旧参数音频被当作最新结果。
      if (generation !== previewGeneration || !sameTuneSettings(snapshot, { ...settings })) {
        notice.value = '参数已更新，试听的是最新效果，请再次点击“采用”。';
        return;
      }
      draft.audio = result.blob;
      adopted.value = { fingerprint: result.fingerprint };
      tuningDirty.value = false;
      clipWarning.value = result.clipped
        ? `检测到 ${result.eventCount > 1 ? result.eventCount + ' 处' : ''}削波（峰值 ${result.peak.toFixed(2)}），建议降低音量后重新采用。`
        : '';
      notice.value = '已采用当前效果，可以继续微调或进入分析。';
    } catch (cause) {
      // 失败不破坏已采用内容与原片段，可重试。
      error.value = cause instanceof Error ? cause.message : '声音处理失败，之前的内容仍保留。';
    } finally {
      processing.value = false;
    }
  }

  /** 确认采用的音频与当前参数/片段严格配对，才允许进入分析与保存。 */
  function adoptedInSync(): boolean {
    if (!draft.audio || !adopted.value) return false;
    const fp = adopted.value.fingerprint;
    return fp.sourceStart === draft.cropStart
      && fp.sourceEnd === draft.cropEnd
      && sameTuneSettings(fp.settings, { ...settings });
  }

  async function analyze() {
    if (!draft.source) { error.value = '请先录制或导入一段声音'; return; }
    if (!adoptedInSync()) {
      error.value = '请先采用当前参数的处理结果，再进行分析。';
      return;
    }
    error.value = '';
    stopPreview();
    const result = await deps.analyzer.analyze(draft.audio!);
    features.value = result.features; emotion.value = classifyEmotion(result.features);
    cover.value = coverPresetFor(emotion.value.label);
    stage.value = 'emotion';
  }

  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }

  async function save(target?: HTMLCanvasElement) {
    if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    // 最终防线：保存的音频必须与当前参数、片段属于同一次选择，禁止把旧参数音频与新参数一起保存。
    if (!adoptedInSync()) {
      error.value = '调音参数已变更，请重新采用最新效果后再保存。';
      return;
    }
    const audioToSave = draft.audio;
    const fingerprintToSave = adopted.value!.fingerprint;
    try {
      const coverBlob = await deps.renderer.render(cover.value, target);
      const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: audioToSave, duration: draft.cropEnd - draft.cropStart, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() };
      await deps.repository.save(meme);
      // 保存往返后再次核对：防止保存失败/重试后状态已被改动导致的错配。
      if (draft.audio !== audioToSave || !adoptedInSync() || adopted.value!.fingerprint !== fingerprintToSave) {
        error.value = '保存期间参数发生变化，请确认作品内容后重试。';
        return;
      }
      await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地';
    } catch {
      // 保存失败：原片段、已采用音频、参数与分析结果全部保留，可直接重试。
      error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。';
    }
  }

  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) {
    Object.assign(draft, { id:meme.id,title:meme.title,source:meme.audio,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration });
    // 已保存作品即“已采用成品”：参数归一为成品状态，保证再次保存依旧配对。
    settings.gain = 1; settings.fadeIn = 0; settings.fadeOut = 0;
    const fingerprint: ProcessFingerprint = { sourceStart:0, sourceEnd:meme.duration, settings:{ ...settings }, generation:0 };
    adopted.value = { fingerprint }; tuningDirty.value = false; clipWarning.value = '';
    features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover';
  }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() {
    stopPreview();
    draft.id = undefined; draft.title = '我的声音表情'; draft.source = undefined; draft.audio = undefined;
    resetTune(); emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = '';
  }

  return {
    stage, error, notice, level, draft, settings, processing, tuningDirty, clipWarning, previewPeak,
    startRecording, stopRecording, importAudio, goTune, goCrop, updateGain, updateFadeIn, updateFadeOut,
    previewOriginal, previewProcessed, stopPreview, applyTune, adoptedInSync,
    analyze, selectEmotion, goCover, save, loadCollection, editMeme, deleteMeme, shareMeme, newRecording,
    emotion, features, cover, collection,
  };
}
