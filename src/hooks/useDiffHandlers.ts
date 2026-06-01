import { useCallback } from 'react'
import { Node as ProseMirrorNode, Mark as ProseMirrorMark } from '@tiptap/pm/model'
import { Editor } from '@tiptap/react'
import type { CanvasDocument } from '../store/useAppStore'

export function useDiffHandlers(
  activeEditor: Editor | null,
  activeDoc: Pick<CanvasDocument, 'content'>,
  updateActiveDocument: (updates: Partial<CanvasDocument>) => void,
  triggerUnsaved: () => void
) {
  // Accept all additions and finalize all deletions in active document
  const handleAcceptAllDiffs = useCallback(() => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (node.isText) {
          node.marks.forEach((mark: ProseMirrorMark) => {
            if (mark.type.name === 'diffAddition' || mark.type.name === 'diffDeletion') {
              changes.push({
                from: pos,
                to: pos + node.nodeSize,
                type: mark.type.name === 'diffAddition' ? 'addition' : 'deletion'
              })
            }
          })
        }
      })

      changes.sort((a, b) => b.from - a.from)
      changes.forEach(change => {
        if (change.type === 'addition') {
          tr.removeMark(change.from, change.to, state.schema.marks.diffAddition)
        } else {
          tr.delete(change.from, change.to)
        }
      })
      view.dispatch(tr)
      updateActiveDocument({ content: activeEditor.getHTML() })
    } else {
      const cleaned = activeDoc.content
        .replace(/<ins[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/ins>/g, '$1')
        .replace(/<del[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/del>/g, '')
      updateActiveDocument({ content: cleaned })
    }
    triggerUnsaved()
  }, [activeEditor, activeDoc.content, updateActiveDocument, triggerUnsaved])

  // Reject all additions and restore all deleted text in active document
  const handleRejectAllDiffs = useCallback(() => {
    if (activeEditor) {
      const { state, view } = activeEditor
      const { doc } = state
      const tr = state.tr
      const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

      doc.descendants((node: ProseMirrorNode, pos: number) => {
        if (node.isText) {
          node.marks.forEach((mark: ProseMirrorMark) => {
            if (mark.type.name === 'diffAddition' || mark.type.name === 'diffDeletion') {
              changes.push({
                from: pos,
                to: pos + node.nodeSize,
                type: mark.type.name === 'diffAddition' ? 'addition' : 'deletion'
              })
            }
          })
        }
      })

      changes.sort((a, b) => b.from - a.from)
      changes.forEach(change => {
        if (change.type === 'addition') {
          tr.delete(change.from, change.to)
        } else {
          tr.removeMark(change.from, change.to, state.schema.marks.diffDeletion)
        }
      })
      view.dispatch(tr)
      updateActiveDocument({ content: activeEditor.getHTML() })
    } else {
      const cleaned = activeDoc.content
        .replace(/<ins[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/ins>/g, '')
        .replace(/<del[^>]*data-diff-id="[^"]*"[^>]*>([\s\S]*?)<\/del>/g, '$1')
      updateActiveDocument({ content: cleaned })
    }
    triggerUnsaved()
  }, [activeEditor, activeDoc.content, updateActiveDocument, triggerUnsaved])

  return {
    handleAcceptAllDiffs,
    handleRejectAllDiffs
  }
}
