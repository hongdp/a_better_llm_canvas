/**
 * The streamed bubble and the completion notes: document markup that no
 * channel takes must never be shown, during the stream or after it.
 */
import { describe, it, expect } from 'vitest'
import { splitStreamingResponse, buildCompletionWarnings } from '../chat/streamHandlers'

const EDIT = '<edit>\n<<<<<<< SEARCH\n<p>a later sentence</p>\n=======\n<p>a smoothed sentence</p>\n>>>>>>> REPLACE\n</edit>'

describe('splitStreamingResponse — markup beside a selection stays out of the bubble', () => {
  it('hides an edit that follows the selection block', () => {
    const r = splitStreamingResponse(`Done.\n<selection_replace><p>x</p></selection_replace>\n${EDIT}`)
    expect(r.isSelectionEdit).toBe(true)
    expect(r.selectionReplaceText).toBe('<p>x</p>')
    expect(r.chatText.trim()).toBe('Done.')
  })

  it('hides an edit that precedes the selection block', () => {
    const r = splitStreamingResponse(`Done.\n${EDIT}\n<selection_replace><p>x</p>`)
    expect(r.isSelectionEdit).toBe(true)
    expect(r.chatText.trim()).toBe('Done.')
  })

  it('hides an edit that follows a closed canvas', () => {
    const r = splitStreamingResponse(`Done.\n<canvas><p>doc</p></canvas>\n${EDIT}`)
    expect(r.canvasText).toBe('<p>doc</p>')
    expect(r.chatText.trim()).toBe('Done.')
  })

  it('still shows chat that follows the selection block', () => {
    const r = splitStreamingResponse('Done.\n<selection_replace><p>x</p></selection_replace>\nAnything else?')
    expect(r.chatText).toBe('Done.\n\nAnything else?')
  })
})

describe('buildCompletionWarnings — markup no channel could take', () => {
  const base = { canvasIssue: null, editFailedCount: 0, exhaustedNoActionRetries: false, reinsertedImages: 0 }

  it('says such changes existed, without showing them', () => {
    expect(buildCompletionWarnings({ ...base, strayMarkup: 2 })).toContain('This reply also contained 2 document changes')
    expect(buildCompletionWarnings({ ...base, strayMarkup: 1 })).toContain('1 document change that could not be applied')
  })

  it('stays quiet when a louder note already says the update failed as a whole', () => {
    expect(buildCompletionWarnings({ ...base, strayMarkup: 1, exhaustedNoActionRetries: true })).not.toContain('This reply also contained')
    expect(buildCompletionWarnings({ ...base, strayMarkup: 1, unretriableFailedUpdate: true })).not.toContain('This reply also contained')
  })

  it('adds nothing when there was none', () => {
    expect(buildCompletionWarnings({ ...base, strayMarkup: 0 })).toBe('')
  })
})
