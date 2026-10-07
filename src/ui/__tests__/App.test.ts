import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import App from '../App.vue';
import type { StudioDependencies } from '../useStudio';
import type { VoiceMeme } from '../../core/models';

function deps(options: { denied?: boolean } = {}): StudioDependencies {
  const works: VoiceMeme[] = [];
  return {
    recorder:{isRecording:false,start:async()=>{if(options.denied)throw new DOMException('denied','NotAllowedError')},stop:async()=>new Blob(['voice'],{type:'audio/webm'})},
    analyzer:{analyze:async()=>({duration:2,features:{loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6}})},
    cropper:{
      inspect:async()=>({duration:2,needsCrop:false}),
      crop:async(blob,range)=>({blob,duration:range.end-range.start}),
      process:async(blob,range,settings,generation)=>({blob:new Blob(['tuned']),duration:range.end-range.start,peak:.5,clipped:false,eventCount:0,fingerprint:{sourceStart:range.start,sourceEnd:range.end,settings:{...settings},generation}}),
    },
    preview:{cancel:vi.fn(),preview:vi.fn(async()=>({stop:vi.fn()}))},
    renderer:{render:async()=>new Blob(['cover'],{type:'image/png'})},
    repository:{list:async()=>works,save:async(m)=>{works.push(m)},rename:async()=>{},delete:async(id)=>{const i=works.findIndex(w=>w.id===id);if(i>=0)works.splice(i,1)}},
    share:{share:async()=> 'shared'},
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe('Voice meme App', () => {
  it('shows the studio stages, time limit and sharing disclosure', () => {
    const wrapper = mount(App,{props:{dependencies:deps()}});
    expect(wrapper.text()).toContain('声音表情包工坊');
    expect(wrapper.text()).toContain('00:10 MAX');
    expect(wrapper.text()).toContain('分享链接不包含原始声音');
    expect(wrapper.text()).toContain('调音');
  });
  it('shows a recoverable microphone permission error', async () => {
    const wrapper=mount(App,{props:{dependencies:deps({denied:true})}}); await wrapper.get('[data-testid="record"]').trigger('click'); await flush();
    expect(wrapper.text()).toContain('麦克风权限');
  });
  it('creates, tunes, labels, edits and saves a work to the gallery', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await flush();
    await wrapper.get('[data-testid="to-tune"]').trigger('click'); await flush();
    const gain = wrapper.get('[data-testid="gain"]');
    await gain.setValue(1.5);
    await wrapper.get('[data-testid="fade-in"]').setValue(0.4);
    expect(wrapper.text()).toContain('采用当前效果');
    expect(wrapper.vm).toBeTruthy();
    await wrapper.get('[data-testid="apply-tune"]').trigger('click'); await flush(); await flush();
    // 采用后分析按钮可用
    await wrapper.get('[data-testid="tune-analyze"]').trigger('click'); await flush();
    await wrapper.get('[data-emotion="温柔姐姐"]').trigger('click'); expect(wrapper.text()).toContain('已手动选择');
    await wrapper.get('[data-testid="to-cover"]').trigger('click'); await wrapper.get('[aria-label="气泡文字"]').setValue('轻轻说一句'); await wrapper.get('[data-testid="save-work"]').trigger('click'); await flush(); await flush();
    expect(wrapper.text()).toContain('作品集'); expect(wrapper.text()).toContain('我的声音表情');
  });
  it('blocks analysis until the latest tuning is adopted', async () => {
    const wrapper=mount(App,{props:{dependencies:deps()}});
    await wrapper.get('[data-testid="record"]').trigger('click'); await wrapper.get('[data-testid="stop"]').trigger('click'); await flush();
    await wrapper.get('[data-testid="to-tune"]').trigger('click'); await flush();
    const analyzeButton = wrapper.get('[data-testid="tune-analyze"]').element as HTMLButtonElement;
    expect(analyzeButton.disabled).toBe(true);
    await wrapper.get('[data-testid="apply-tune"]').trigger('click'); await flush(); await flush();
    expect((wrapper.get('[data-testid="tune-analyze"]').element as HTMLButtonElement).disabled).toBe(false);
  });
});
