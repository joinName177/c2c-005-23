import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';
import { applyEffects } from '../../core/audio-effects';

function effectsPort() {
  return {
    decode: async () => ({ sampleRate: 10, duration: 2, channels: [Float32Array.from({ length: 20 }, (_, i) => i % 5 ? .8 : 0)], peak: .8 }),
    render: (source: Parameters<typeof applyEffects>[0], params: Parameters<typeof applyEffects>[1]) => applyEffects(source, params),
    encode: () => new Blob(['fx'], { type: 'audio/wav' }),
    play: async () => ({ stop() {}, done: Promise.resolve() }),
  } satisfies StudioDependencies['effects'];
}

function deps(options: { denied?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
    cropper:{inspect:async()=>({duration:2,needsCrop:false}),crop:async(blob,range)=>({blob:new Blob([blob,`${range.end-range.start}`]),duration:range.end-range.start})},
    effects:effectsPort(),
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}}); await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="analyze"]').trigger('click'); await Promise.resolve(); await Promise.resolve(); await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('adjusts gain and fades, previews clipping, adopts and saves the committed audio', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await Promise.resolve();
    await wrapper.get('[data-testid="adjust"]').trigger('click'); await Promise.resolve();
    expect(wrapper.text()).toContain('调音量、加首尾淡化');

    await wrapper.get('[data-testid="gain"]').setValue('2');
    // 原峰值 0.8 × 增益 2 = 1.6：拖动中立刻给出可察觉的削波警示（无需等待渲染）。
    expect(wrapper.get('[data-testid="clip-box"]').text()).toContain('削波');
    await wrapper.get('[data-testid="fade-in"]').setValue('0.5');
    await wrapper.get('[data-testid="fx-apply"]').trigger('click');
    await Promise.resolve(); await Promise.resolve();
    expect(wrapper.find('[data-emotion="元气满满"]').exists()).toBe(true);
    await wrapper.get('[data-testid="to-cover"]').trigger('click');
    await wrapper.get('[data-testid="save-work"]').trigger('click'); await Promise.resolve(); await Promise.resolve();
    expect(wrapper.text()).toContain('作品已保存到本地');
  });
});
