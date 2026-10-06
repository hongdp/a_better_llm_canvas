import { describe, it, expect } from 'vitest'
import {
  splitForPolish,
  buildPolishPrompt,
  parsePolished,
  validatePolished,
  assemblePolished,
  bare,
  POLISH_CHUNK_CHARS
} from '../polish'

const para = (n: number, ch = '字') => `<p>${ch.repeat(n)}。</p>`

describe('splitForPolish', () => {
  it('groups whole paragraphs into chunks of about the target size', () => {
    const html = para(600) + para(600) + para(300)
    const segs = splitForPolish(html, POLISH_CHUNK_CHARS)
    expect(segs.map(s => s.kind === 'chunk' ? s.paras.length : 'fixed')).toEqual([2, 1])
  })

  it('never sends headings or images to be rewritten, and lets them end a chunk', () => {
    const html = '<h2>第一章</h2>' + para(100) + '<p><img src="x.png"></p>' + para(100) + '<p>{{IMAGE_PLACEHOLDER_0}}</p>'
    const segs = splitForPolish(html)
    expect(segs.map(s => s.kind)).toEqual(['fixed', 'chunk', 'fixed', 'chunk', 'fixed'])
    expect(segs[0]).toEqual({ kind: 'fixed', html: '<h2>第一章</h2>' })
  })

  it('keeps inline formatting in the paragraphs it sends', () => {
    const segs = splitForPolish('<p>她<strong>没有</strong>回头。</p>')
    expect(segs).toEqual([{ kind: 'chunk', paras: ['她<strong>没有</strong>回头。'] }])
  })
})

describe('buildPolishPrompt', () => {
  it('fills the size, the previous chunk\'s last sentence, and the chunk', () => {
    const t = 'n={n}|prev={prev}|part={part}'
    expect(buildPolishPrompt(t, ['他来了。她走了。'], ['前面一句。最后一句！'])).toBe('n=6|prev=最后一句！|part=<p>他来了。她走了。</p>')
    expect(buildPolishPrompt(t, ['开头。'], null)).toContain('prev=（本段是开头）')
  })
})

describe('parsePolished', () => {
  it('reads <p> paragraphs, or lines when the model sent none', () => {
    expect(parsePolished('说明\n<p>一</p>\n<p class="x">二</p>')).toEqual(['一', '二'])
    expect(parsePolished('一\n\n二')).toEqual(['一', '二'])
  })
})

describe('validatePolished — the measured thresholds', () => {
  const draft = ['他推开门，看见她坐在窗边。', '“你回来了。”她说。']
  // 17 bare chars → 20 (+18%), inside −10%…+30%.
  const ok = ['他推开门时，看见她坐在窗边。', '“你回来了。”她轻声说。']

  it('passes a rewrite inside every bound', () => {
    expect(validatePolished(draft, ok).ok).toBe(true)
  })

  it('rejects a rewrite more than 30% longer or 10% shorter (bare chars)', () => {
    const long = ['他推开门的时候，看见她正安安静静地坐在靠着窗户的那张旧椅子上。', '“你回来了。”她说。']
    expect(validatePolished(draft, long).reasons.join()).toMatch(/length \+\d+%/)
    expect(validatePolished(draft, ['他推门。', '“你回来了。”']).reasons.join()).toMatch(/length -\d+%/)
  })

  it('rejects a rewrite that changed a line of dialogue', () => {
    const changed = ['他推开门时，看见她坐在窗边。', '“你终于回来了。”她轻声说。']
    expect(validatePolished(draft, changed).reasons).toContain('1 dialogue line(s) changed')
  })

  it('rejects a narration clause over 30 chars, but not 30, and not dialogue', () => {
    const d = ['字'.repeat(30) + '。']
    expect(validatePolished(d, ['字'.repeat(30) + '。']).ok).toBe(true)
    expect(validatePolished(d, ['字'.repeat(31) + '。']).reasons).toContain('31-char run-on')
    expect(validatePolished(['“' + '话'.repeat(40) + '”'], ['“' + '话'.repeat(40) + '”']).ok).toBe(true)
  })

  it('allows two paragraphs merged into one, not more', () => {
    const three = ['一一一一一。', '二二二二二。', '三三三三三。']
    expect(validatePolished(three, ['一一一一一，二二二二二。', '三三三三三。']).ok).toBe(true)
    expect(validatePolished(three, ['一一一一一，二二二二二，三三三三三。']).reasons).toContain('2 paragraphs lost')
  })

  it('counts length like the measurement: punctuation and spaces excluded', () => {
    expect(bare('他说：“好， 走。”')).toBe('他说好走')
  })
})

describe('assemblePolished', () => {
  it('puts each rewrite back in place, a draft where none passed, fixed blocks untouched', () => {
    const segs = splitForPolish('<h2>T</h2><p>a</p><p>{{IMAGE_PLACEHOLDER_0}}</p><p>b</p>')
    expect(assemblePolished(segs, [['A'], null])).toBe('<h2>T</h2><p>A</p><p>{{IMAGE_PLACEHOLDER_0}}</p><p>b</p>')
  })
})
