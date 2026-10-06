import { describe, it, expect } from 'vitest'
import { pendingChanges, renderPendingChanges } from '../pendingChanges'
import { diffHtml } from '../diff'

describe('pendingChanges', () => {
  it('lists each changed paragraph as now / was, and nothing that did not change', () => {
    const html = diffHtml(
      '<p>开头。</p><p>阿青推开门，屋里很暗。</p><p>结尾。</p>',
      '<p>开头。</p><p>阿青轻轻推开门，屋里一片昏暗。</p><p>结尾。</p>'
    )
    expect(pendingChanges(html)).toEqual([
      { was: '阿青推开门，屋里很暗。', now: '阿青轻轻推开门，屋里一片昏暗。' }
    ])
  })

  it('reports an added and a removed paragraph', () => {
    const added = pendingChanges(diffHtml('<p>一。</p>', '<p>一。</p><p>新增的一段。</p>'))
    expect(added).toEqual([{ was: '', now: '新增的一段。' }])
    const removed = pendingChanges(diffHtml('<p>一。</p><p>要删的一段。</p>', '<p>一。</p>'))
    expect(removed).toEqual([{ was: '要删的一段。', now: '' }])
  })

  it('is empty for a chapter with nothing pending', () => {
    expect(pendingChanges('<p>平静的一段。</p>')).toEqual([])
    expect(renderPendingChanges([])).toBe('')
  })

  it('tells the model to restore only the part asked for', () => {
    const text = renderPendingChanges([{ was: '旧', now: '新' }, { was: '', now: '加' }])
    expect(text).toContain('1. now: "新"\n   was: "旧"')
    expect(text).toContain('2. now: "加"\n   was: (added by the change)')
    expect(text).toContain('change ONLY that part')
  })
})
