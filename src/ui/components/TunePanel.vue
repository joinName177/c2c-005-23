<script setup lang="ts">
import { computed } from 'vue';
import { TUNE_GAIN_MAX, TUNE_GAIN_MIN, TUNE_GAIN_STEP, type TuneSettings } from '../../core/models';

const props = defineProps<{
  duration: number;
  settings: TuneSettings;
  processing: boolean;
  dirty: boolean;
  clipWarning: string;
  previewPeak: number;
}>();
const emit = defineEmits<{
  updateGain: [n: number];
  updateFadeIn: [n: number];
  updateFadeOut: [n: number];
  previewOriginal: [];
  previewProcessed: [];
  stopPreview: [];
  apply: [];
  analyze: [];
  back: [];
}>();

const maxFade = computed(() => Math.max(0, props.duration / 2));
const gainPercent = computed(() => ((props.settings.gain - TUNE_GAIN_MIN) / (TUNE_GAIN_MAX - TUNE_GAIN_MIN)) * 100);
const draggingHint = computed(() => (props.settings.gain > 1 ? '注意：超过 100% 可能削波' : ''));
</script>
<template>
  <section class="stage-card tune-panel">
    <span class="kicker">02+ / SHAPE THE SOUND</span>
    <h2>调好音量与首尾淡化</h2>
    <p class="tune-tip">拖动时实时试听的是最新参数；所有效果都以保留的原片段为依据，不会叠加放大。</p>

    <div class="tune-controls">
      <label class="tune-row">
        <span>音量 <b>{{ Math.round(settings.gain * 100) }}%</b></span>
        <input type="range" :min="TUNE_GAIN_MIN" :max="TUNE_GAIN_MAX" :step="TUNE_GAIN_STEP" :value="settings.gain"
               :style="{ '--fill': `${gainPercent}%` }" data-testid="gain"
               @input="emit('updateGain', Number(($event.target as HTMLInputElement).value))">
        <em v-if="draggingHint" class="gain-hint">{{ draggingHint }}</em>
      </label>
      <label class="tune-row">
        <span>淡入 <b>{{ settings.fadeIn.toFixed(1) }}s</b></span>
        <input type="range" min="0" :max="maxFade" step="0.1" :value="settings.fadeIn" data-testid="fade-in"
               @input="emit('updateFadeIn', Number(($event.target as HTMLInputElement).value))">
      </label>
      <label class="tune-row">
        <span>淡出 <b>{{ settings.fadeOut.toFixed(1) }}s</b></span>
        <input type="range" min="0" :max="maxFade" step="0.1" :value="settings.fadeOut" data-testid="fade-out"
               @input="emit('updateFadeOut', Number(($event.target as HTMLInputElement).value))">
      </label>
    </div>

    <div class="preview-clips">
      <div class="clip-choice">
        <strong>原片段（依据）</strong>
        <p>未做任何处理的裁剪结果</p>
        <div class="clip-buttons">
          <button type="button" data-testid="preview-original" @mousedown="emit('previewOriginal')" @touchstart.prevent="emit('previewOriginal')" @mouseup="emit('stopPreview')" @mouseleave="emit('stopPreview')" @touchend="emit('stopPreview')">按住试听</button>
        </div>
      </div>
      <div class="clip-choice processed">
        <strong>处理后</strong>
        <p>当前音量与淡入淡出效果</p>
        <div class="clip-buttons">
          <button type="button" data-testid="preview-processed" @click="emit('previewProcessed')">试听</button>
          <button type="button" data-testid="stop-preview" @click="emit('stopPreview')">停止</button>
        </div>
      </div>
    </div>

    <div v-if="previewPeak > 1 && !clipWarning" class="soft-warning" data-testid="preview-clip">当前音量可能接近削波，采用后会给出准确检测。</div>
    <div v-if="clipWarning" class="clip-warning" data-testid="clip-warning">⚠ {{ clipWarning }}</div>

    <div class="tune-actions">
      <button type="button" class="ghost-button" data-testid="tune-back" @click="emit('back')">← 重新裁剪</button>
      <button type="button" class="acid-button" data-testid="apply-tune" :disabled="processing" @click="emit('apply')">
        {{ processing ? '处理中…' : dirty ? '采用当前效果' : '已采用（参数无改动）' }}
      </button>
    </div>
    <button type="button" class="acid-button primary-next" data-testid="tune-analyze" :disabled="dirty" @click="$emit('analyze')">
      采用后分析这段声音 →
    </button>
    <p v-if="dirty" class="sync-hint">参数已改动，分析与保存使用的是上一次“采用”的声音，请先采用最新效果。</p>
  </section>
</template>
