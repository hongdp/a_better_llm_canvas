import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useAppStore } from '../useAppStore'
import { isBlankContent } from '../slices/documentsSlice'

/**
 * A chapter of prose was replaced with an empty document and auto-saved over,
 * with no version snapshot behind it. The write came from a completion path
 * restoring its "leave it as it was" base — a base captured before the
 * chapter's lazy content had loaded, so it was ''.
 *
 * The caller is fixed, but this guard is what makes the class of bug survivable
 * rather than expensive: the app never blanks a chapter on its own.
 */
describe('isBlankContent', () => {
  it('recognises the shapes an empty editor produces', () => {
    for (const blank of ['', '   ', '<p></p>', '<p> </p>', '<p><br></p>', '<p>&nbsp;</p>', '<p></p><p></p>']) {
      expect(isBlankContent(blank), JSON.stringify(blank)).toBe(true)
    }
  })

  it('does not mistake real content for blank', () => {
    for (const real of ['<p>a</p>', '<h1>Title</h1>', '<p><strong>x</strong></p>', '<img src="data:x">']) {
      expect(isBlankContent(real), real).toBe(false)
    }
  })
})

describe('updateActiveDocument blank guard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useAppStore.setState({
      documents: [{
        id: 'doc-1', title: 'Chapter 1',
        content: '<p>三千字的正文</p>', contentLoaded: true,
        createdAt: '', updatedAt: ''
      }] as never,
      activeDocumentId: 'doc-1'
    })
  })
  afterEach(() => vi.restoreAllMocks())

  const content = () => useAppStore.getState().documents[0].content

  it('refuses to blank a chapter that has content', () => {
    useAppStore.getState().updateActiveDocument({ content: '' })
    expect(content()).toBe('<p>三千字的正文</p>')

    useAppStore.getState().updateActiveDocument({ content: '<p></p>' })
    expect(content()).toBe('<p>三千字的正文</p>')
  })

  it('still allows ordinary edits, including big deletions', () => {
    useAppStore.getState().updateActiveDocument({ content: '<p>短</p>' })
    expect(content()).toBe('<p>短</p>')
  })

  it('allows writing into an already-empty chapter', () => {
    // The first draft of a new chapter must not be blocked by the guard.
    useAppStore.setState({ documents: [{ id: 'doc-1', title: 'x', content: '<p></p>', createdAt: '', updatedAt: '' }] as never })
    useAppStore.getState().updateActiveDocument({ content: '<p>first draft</p>' })
    expect(content()).toBe('<p>first draft</p>')
  })

  it('leaves updates that do not touch content alone', () => {
    useAppStore.getState().updateActiveDocument({ title: 'Renamed' })
    expect(useAppStore.getState().documents[0].title).toBe('Renamed')
    expect(content()).toBe('<p>三千字的正文</p>')
  })
})
