import { describe, it, expect } from 'vitest'
import { chapterParagraphs, numberedLine } from '../paragraphs'

describe('chapterParagraphs', () => {
  it('numbers every non-empty top-level block, headings and images included', () => {
    const paras = chapterParagraphs('<h1>标题</h1><p>一。</p><p></p><p><img src="x"></p><ul><li>a</li><li>b</li></ul>loose')
    expect(paras.map(p => [p.number, p.kind, p.text])).toEqual([
      [1, 'heading', '标题'],
      [2, 'paragraph', '一。'],
      [3, 'image', ''],
      [4, 'other', 'a\nb'],
      [5, 'paragraph', 'loose']
    ])
  })

  it('treats an image placeholder token as an image', () => {
    expect(chapterParagraphs('<p>{{IMAGE_PLACEHOLDER_3}}</p>')[0].kind).toBe('image')
  })

  it('renders one line per paragraph for a text read', () => {
    const [h, p, img, list] = chapterParagraphs('<h2>T</h2><p>a &amp; b</p><p><img src="x"></p><ul><li>x</li><li>y</li></ul>')
    expect([h, p, img, list].map(numberedLine)).toEqual(['¶1 # T', '¶2 a & b', '¶3 [image]', '¶4 x / y'])
  })
})
