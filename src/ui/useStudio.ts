import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { AudioEffectsPort } from '../ports/audio-effects.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';
import { useAudioPreview } from './useAudioPreview';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; effects: AudioEffectsPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  // segmentBlob：保留下来的裁剪原片段（所有音量/淡化处理的唯一依据）；draft.audio：确认后的成品。
  const draft = reactive<{ id?: string; title: string; audio?: Blob; segmentBlob?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);
  const adjustMode = ref(false);
  const preview = useAudioPreview(deps.effects);

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); preview.detach(); draft.segmentBlob = undefined; const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); adjustMode.value = false; stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; preview.detach(); draft.segmentBlob = undefined; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); adjustMode.value = false; stage.value = 'crop'; }

  /** 裁剪确认：只从原始录音/导入生成保留片段，绝不基于已处理结果再处理。 */
  async function enterAdjust() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    error.value = '';
    try {
      const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd });
      draft.segmentBlob = cropped.blob;
      draft.duration = cropped.duration;
      preview.attach(await deps.effects.decode(cropped.blob));
      adjustMode.value = true;
      notice.value = '调整音量与首尾淡化，可随时对比原声试听';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '裁剪失败，请重新选择片段';
    }
  }
  function backToCrop() { adjustMode.value = false; notice.value = ''; }
  async function cancelAdjust() {
    // 取消只丢弃效果参数与处理结果，保留片段、裁剪范围与滑块位置仍可恢复。
    preview.resetParams();
    adjustMode.value = false;
    preview.stopPlayback();
    notice.value = '';
  }

  /** 以“已确认效果的 Blob + 同次世代的参数”进入情绪分析；不沿用任何在途试听结果。 */
  async function runAnalysis() {
    if (!draft.segmentBlob) { error.value = '请先确认裁剪片段'; return; }
    error.value = '';
    try {
      const accepted = preview.commit();
      draft.audio = accepted.blob;
      draft.duration = preview.effectiveDuration.value;
      const result = await deps.analyzer.analyze(accepted.blob);
      features.value = result.features;
      emotion.value = classifyEmotion(result.features);
      cover.value = coverPresetFor(emotion.value.label);
      preview.stopPlayback();
      stage.value = 'emotion';
    } catch (cause) {
      // 分析失败：保留片段、参数与已确认试听内容都还在，可直接重试。
      error.value = cause instanceof Error ? cause.message : '声音分析失败，请重试';
    }
  }
  /**
   * 裁剪页“分析这段声音”：以原始音量、无淡化的权威渲染进入分析。
   * 保证情绪分析与保存拿到的都是同一条处理链的产物，而不是未渲染的中间片段。
   */
  async function analyze() {
    if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; }
    error.value = '';
    try {
      if (!draft.segmentBlob) await enterAdjust();
      if (error.value || !draft.segmentBlob) return;
      await runAnalysis();
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '声音分析失败，请重试';
    }
  }

  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) {
    if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; }
    // 保存前最后一道防线：确认过效果后又改了参数时，拒绝把旧音频与新参数一起保存。
    if (!preview.legacy.value && draft.segmentBlob && !preview.isCommitted.value) {
      error.value = '试听参数已变化，请重新“采用效果并分析”后再保存';
      return;
    }
    try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,segmentBlob:undefined,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; preview.detach(); preview.markLegacy(meme.audio); adjustMode.value = false; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  async function shareMeme(meme: VoiceMeme) { const result = await deps.share.share(meme); notice.value = result === 'shared' ? '已打开系统分享' : '浏览器不支持文件分享，已下载音频和封面'; }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; draft.segmentBlob = undefined; emotion.value = undefined; features.value = undefined; preview.detach(); adjustMode.value = false; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,adjustMode,preview,startRecording,stopRecording,importAudio,enterAdjust,backToCrop,cancelAdjust,runAnalysis,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,newRecording };
}
