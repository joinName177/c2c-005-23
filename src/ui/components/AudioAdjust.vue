<script setup lang="ts">
import { computed } from 'vue';
import type { AudioEffectParams } from '../../core/audio-effects';

const props = defineProps<{
  duration: number;
  params: AudioEffectParams;
  processing: boolean;
  playing: boolean;
  predictedClip: boolean;
  confirmedClip: boolean;
  clippedRatio: number;
  isCommitted: boolean;
  dirtyAfterCommit: boolean;
  error: string;
}>();
const emit = defineEmits<{
  updateGain: [n: number];
  updateFadeIn: [n: number];
  updateFadeOut: [n: number];
  previewOriginal: [];
  previewProcessed: [];
  reset: [];
  cancel: [];
  apply: [];
}>();

// 两段淡化之和不得超过片段长度，因此一个滑块的可用上界要扣掉另一段。
const fadeInMax = computed(() => Math.max(0, props.duration - props.params.fadeOut));
const fadeOutMax = computed(() => Math.max(0, props.duration - props.params.fadeIn));
</script>
<template>
  <section class="stage-card adjust-panel">
    <span class="kicker">02B / SHAPE THE SOUND</span>
    <h2>调音量、加首尾淡化</h2>
    <p class="adjust-hint">每次调整都以保留的原片段重新计算，不会反复处理放大误差。</p>

    <div class="fx-row">
      <label>音量 {{ params.gain.toFixed(2) }}×
        <input type="range" min="0" max="2" step="0.01" :value="params.gain" data-testid="gain"
          @input="emit('updateGain', Number(($event.target as HTMLInputElement).value))">
      </label>
    </div>
    <div class="range-pair">
      <label>淡入 {{ params.fadeIn.toFixed(2) }}s
        <input type="range" min="0" :max="fadeInMax" step="0.01" :value="params.fadeIn" data-testid="fade-in"
          @input="emit('updateFadeIn', Number(($event.target as HTMLInputElement).value))">
      </label>
      <label>淡出 {{ params.fadeOut.toFixed(2) }}s
        <input type="range" min="0" :max="fadeOutMax" step="0.01" :value="params.fadeOut" data-testid="fade-out"
          @input="emit('updateFadeOut', Number(($event.target as HTMLInputElement).value))">
      </label>
    </div>

    <div class="clip-box" data-testid="clip-box" :class="{ clipping: predictedClip || confirmedClip }">
      <strong v-if="confirmedClip">⚠ 削波：约 {{ (clippedRatio * 100).toFixed(1) }}% 样本被截断，声音可能破音</strong>
      <strong v-else-if="predictedClip">⚠ 当前音量可能削波，松手后会精确检测</strong>
      <span v-else>未检测到削波</span>
    </div>

    <p v-if="processing" class="fx-status" data-testid="fx-processing">正在更新试听…</p>
    <p v-if="error" class="fx-error" data-testid="fx-error">{{ error }}</p>

    <div class="fx-actions">
      <button type="button" data-testid="preview-original" :disabled="playing" @click="emit('previewOriginal')">▶ 听原声</button>
      <button type="button" data-testid="preview-processed" @click="emit('previewProcessed')">▶ 听效果</button>
      <button type="button" data-testid="fx-reset" @click="emit('reset')">复位</button>
    </div>
    <div class="fx-actions">
      <button type="button" class="ghost-button" data-testid="fx-back" @click="emit('cancel')">返回裁剪（保留参数）</button>
      <button type="button" class="acid-button" data-testid="fx-apply"
        @click="emit('apply')">{{ dirtyAfterCommit ? '重新采用并分析' : '采用效果并分析 →' }}</button>
    </div>
    <p v-if="dirtyAfterCommit" class="fx-warn" data-testid="fx-dirty">参数在已采用后又被改动，需重新采用；否则保存的仍是旧参数音频。</p>
  </section>
</template>
