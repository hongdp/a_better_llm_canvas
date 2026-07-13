import React, { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { 
  Bold, 
  Italic, 
  Heading1, 
  Heading2, 
  Heading3,
  List, 
  ListOrdered, 
  Indent,
  Outdent,
  Code,
  Quote,
  Check,
  X,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
  Languages,
  Wand2,
  Undo2,
  Redo2,
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
// TipTap extension definitions live in editorExtensions.ts so this file only
// exports components (react-refresh/only-export-components).
import { IndentExtension, DiffAddition, DiffDeletion, CustomImage, BlurredSelection } from './editorExtensions'

interface EditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  isActive?: boolean
}

export const Editor: React.FC<EditorProps> = ({ 
  content, 
  onChange, 
  placeholder = 'Start writing your document here or let the assistant draft it...',
  isActive = true
}) => {
  const { setSelectedText, setActiveEditor, isStreaming } = useAppStore()

  // Track content strings that originated FROM this editor's onUpdate.
  // When the content prop changes because of our own edit (user typed/pasted → onUpdate
  // → onChange → Zustand → re-render → new content prop), we must NOT call setContent
  // because the editor already has the correct state. Calling setContent in this case
  // causes a race condition where slightly-stale store HTML overwrites the live editor.
  const contentFromEditorRef = useRef<string | null>(null)

  const handleQuickAction = (action: 'rewrite' | 'shorten' | 'expand' | 'grammar') => {
    let prompt = ''
    switch (action) {
      case 'rewrite':
        prompt = 'Rewrite the selected text to make it flow better and sound more professional.'
        break
      case 'shorten':
        prompt = 'Make the selected text more concise and to the point.'
        break
      case 'expand':
        prompt = 'Elaborate on the selected text, adding more detail and depth.'
        break
      case 'grammar':
        prompt = 'Fix any spelling, grammar, or punctuation errors in the selected text.'
        break
    }
    window.dispatchEvent(new CustomEvent('send-quick-action', { detail: prompt }))
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        strike: false,
      }),
      Placeholder.configure({
        placeholder,
      }),
      DiffAddition,
      DiffDeletion,
      BlurredSelection,
      IndentExtension,
      CustomImage,
    ],
    content,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      // Mark this content as originating from the editor itself
      contentFromEditorRef.current = html
      onChange(html)
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to, empty } = editor.state.selection
      if (empty) {
        setSelectedText('')
      } else {
        const slice = editor.state.doc.slice(from, to)
        const serializer = DOMSerializer.fromSchema(editor.state.schema)
        const frag = serializer.serializeFragment(slice.content)
        const div = document.createElement('div')
        div.appendChild(frag)
        setSelectedText(div.innerHTML)
      }
    }
  })

  // Synchronize incoming content updates (e.g. from LLM streaming, version restore) with TipTap.
  // CRITICAL: Skip when the content prop is just echoing back what we sent via onUpdate,
  // otherwise we get a race condition that causes user edits to "roll back".
  useEffect(() => {
    if (!editor) return

    // If this content originated from our own editor's onUpdate, skip the sync.
    // The editor already has the correct state; overwriting it would cause rollback.
    if (contentFromEditorRef.current === content) {
      return
    }

    // Content came from an external source (LLM streaming, version restore, etc.)
    if (content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false })
    }
  }, [content, editor])

  // Disable user editing (make it read-only) while LLM is streaming to avoid sync issues
  useEffect(() => {
    if (editor) {
      editor.setEditable(!isStreaming)
    }
  }, [editor, isStreaming])

  // Sync editor reference globally for bulk actions
  useEffect(() => {
    if (editor && isActive) {
      setActiveEditor(editor)
    }
    return () => {
      if (isActive) {
        setActiveEditor(null)
      }
    }
  }, [editor, isActive, setActiveEditor])

  // Prevent rendering if editor is not initialized
  if (!editor) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
        Loading document editor...
      </div>
    )
  }

  // Handle single diff accept/reject using ProseMirror transactions
  const handleResolveDiff = (diffId: string, action: 'accept' | 'reject') => {
    const { state, view } = editor
    const { doc } = state
    const tr = state.tr
    const changes: { from: number; to: number; type: 'addition' | 'deletion' }[] = []

    doc.descendants((node, pos) => {
      if (node.isText) {
        node.marks.forEach(mark => {
          if (
            (mark.type.name === 'diffAddition' || mark.type.name === 'diffDeletion') &&
            mark.attrs['data-diff-id'] === diffId
          ) {
            changes.push({
              from: pos,
              to: pos + node.nodeSize,
              type: mark.type.name === 'diffAddition' ? 'addition' : 'deletion'
            })
          }
        })
      }
    })

    // Process from end of document to start to preserve relative index offsets
    changes.sort((a, b) => b.from - a.from)

    changes.forEach(change => {
      if (action === 'accept') {
        if (change.type === 'addition') {
          // Keep additions: strip the ins mark
          tr.removeMark(change.from, change.to, state.schema.marks.diffAddition)
        } else {
          // Confirm deletions: erase the text
          tr.delete(change.from, change.to)
        }
      } else {
        // reject
        if (change.type === 'addition') {
          // Deny additions: erase the inserted text
          tr.delete(change.from, change.to)
        } else {
          // Deny deletions: restore the deleted text by stripping the del mark
          tr.removeMark(change.from, change.to, state.schema.marks.diffDeletion)
        }
      }
    })

    view.dispatch(tr)
    onChange(editor.getHTML())
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
      {/* Fixed Formatting Toolbar */}
      {editor && (
        <div className="editor-toolbar" style={{
          display: 'flex',
          gap: '6px',
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-color)',
          alignItems: 'center',
          flexWrap: 'nowrap',
          overflowX: 'auto',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backgroundColor: 'var(--bg-glass)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}>
          {/* Undo / Redo */}
          <button
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
            className="btn-icon"
            title="Undo (Ctrl+Z)"
            type="button"
            style={{
              backgroundColor: 'transparent',
              color: 'inherit',
              opacity: editor.can().undo() ? 1 : 0.35,
              cursor: editor.can().undo() ? 'pointer' : 'default',
            }}
          >
            <Undo2 size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
            className="btn-icon"
            title="Redo (Ctrl+Shift+Z)"
            type="button"
            style={{
              backgroundColor: 'transparent',
              color: 'inherit',
              opacity: editor.can().redo() ? 1 : 0.35,
              cursor: editor.can().redo() ? 'pointer' : 'default',
            }}
          >
            <Redo2 size={16} />
          </button>

          <div style={{ width: '1px', height: '18px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`btn-icon ${editor.isActive('bold') ? 'active' : ''}`}
            title="Bold (Ctrl+B)"
            type="button"
            style={{
              backgroundColor: editor.isActive('bold') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('bold') ? 'var(--accent)' : 'inherit',
            }}
          >
            <Bold size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`btn-icon ${editor.isActive('italic') ? 'active' : ''}`}
            title="Italic (Ctrl+I)"
            type="button"
            style={{
              backgroundColor: editor.isActive('italic') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('italic') ? 'var(--accent)' : 'inherit',
            }}
          >
            <Italic size={16} />
          </button>
          
          <div style={{ width: '1px', height: '18px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            className={`btn-icon ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
            title="Heading 1"
            type="button"
            style={{
              backgroundColor: editor.isActive('heading', { level: 1 }) ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('heading', { level: 1 }) ? 'var(--accent)' : 'inherit',
            }}
          >
            <Heading1 size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={`btn-icon ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
            title="Heading 2"
            type="button"
            style={{
              backgroundColor: editor.isActive('heading', { level: 2 }) ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('heading', { level: 2 }) ? 'var(--accent)' : 'inherit',
            }}
          >
            <Heading2 size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            className={`btn-icon ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
            title="Heading 3"
            type="button"
            style={{
              backgroundColor: editor.isActive('heading', { level: 3 }) ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('heading', { level: 3 }) ? 'var(--accent)' : 'inherit',
            }}
          >
            <Heading3 size={16} />
          </button>

          <div style={{ width: '1px', height: '18px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={`btn-icon ${editor.isActive('bulletList') ? 'active' : ''}`}
            title="Bullet List"
            type="button"
            style={{
              backgroundColor: editor.isActive('bulletList') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('bulletList') ? 'var(--accent)' : 'inherit',
            }}
          >
            <List size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={`btn-icon ${editor.isActive('orderedList') ? 'active' : ''}`}
            title="Numbered List"
            type="button"
            style={{
              backgroundColor: editor.isActive('orderedList') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('orderedList') ? 'var(--accent)' : 'inherit',
            }}
          >
            <ListOrdered size={16} />
          </button>

          <div style={{ width: '1px', height: '18px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button
            onClick={() => {
              if (editor.isActive('listItem')) {
                const hasMarginLeft = editor.state.selection.$from.node().attrs.marginLeft
                if (hasMarginLeft) {
                  editor.chain().focus().outdent().run()
                } else if (editor.can().liftListItem('listItem')) {
                  editor.chain().focus().liftListItem('listItem').run()
                }
              } else {
                editor.chain().focus().outdent().run()
              }
            }}
            className="btn-icon"
            title="Decrease Indent"
            type="button"
            style={{
              backgroundColor: 'transparent',
              color: 'inherit',
            }}
          >
            <Outdent size={16} />
          </button>
          <button
            onClick={() => {
              if (editor.isActive('listItem')) {
                if (editor.can().sinkListItem('listItem')) {
                  editor.chain().focus().sinkListItem('listItem').run()
                } else {
                  editor.chain().focus().indent().run()
                }
              } else {
                editor.chain().focus().indent().run()
              }
            }}
            className="btn-icon"
            title="Increase Indent"
            type="button"
            style={{
              backgroundColor: 'transparent',
              color: 'inherit',
            }}
          >
            <Indent size={16} />
          </button>

          <div style={{ width: '1px', height: '18px', backgroundColor: 'var(--border-color)', margin: '0 4px' }} />

          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={`btn-icon ${editor.isActive('blockquote') ? 'active' : ''}`}
            title="Blockquote"
            type="button"
            style={{
              backgroundColor: editor.isActive('blockquote') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('blockquote') ? 'var(--accent)' : 'inherit',
            }}
          >
            <Quote size={16} />
          </button>
          <button
            onClick={() => editor.chain().focus().toggleCode().run()}
            className={`btn-icon ${editor.isActive('code') ? 'active' : ''}`}
            title="Inline Code"
            type="button"
            style={{
              backgroundColor: editor.isActive('code') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('code') ? 'var(--accent)' : 'inherit',
            }}
          >
            <Code size={16} />
          </button>
        </div>
      )}

      {/* Floating Bubble Menu for Text Selection */}
      {editor && (
        <BubbleMenu 
          editor={editor} 
          updateDelay={100}
          shouldShow={({ editor }) => {
            const { empty } = editor.state.selection
            const isInsideDiff = editor.isActive('diffAddition') || editor.isActive('diffDeletion')
            return !empty || isInsideDiff
          }}
          className="glass-panel"
          style={{
            display: 'flex',
            gap: '4px',
            padding: '4px',
            borderRadius: '8px',
            boxShadow: 'var(--shadow-md)',
            pointerEvents: 'auto',
          }}
        >
          {(() => {
            const isAddition = editor.isActive('diffAddition')
            const isDeletion = editor.isActive('diffDeletion')
            const isInsideDiff = isAddition || isDeletion

            if (isInsideDiff) {
              const attrs = isAddition 
                ? editor.getAttributes('diffAddition') 
                : editor.getAttributes('diffDeletion')
              const diffId = attrs?.['data-diff-id'] || ''

              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 6px' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginRight: '4px' }}>Edit:</span>
                  <button
                    onClick={() => handleResolveDiff(diffId, 'accept')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      fontSize: '0.8rem',
                      color: '#10b981',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: '4px',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(16, 185, 129, 0.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    title="Accept change"
                    type="button"
                  >
                    <Check size={14} /> Accept
                  </button>
                  <button
                    onClick={() => handleResolveDiff(diffId, 'reject')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      fontSize: '0.8rem',
                      color: '#ef4444',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: '4px',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.1)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    title="Reject change"
                    type="button"
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              )
            }

            // Normal text selection formatting & quick actions toolbar
            return (
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <>
                  <>
                    <button
                      onClick={() => {
                        const { from, to, empty } = editor.state.selection
                        const text = empty ? '' : editor.state.doc.textBetween(from, to, ' ')
                        window.dispatchEvent(new CustomEvent('open-image-gen', { detail: text }))
                      }}
                      className="btn-icon"
                      title="Generate image from selection"
                      type="button"
                      style={{
                        background: 'var(--accent)',
                        color: 'var(--accent-text)',
                        borderRadius: '6px',
                        padding: '4px 8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        border: 'none',
                      }}
                    >
                      <Wand2 size={13} />
                      Gen Image
                    </button>
                    {<div style={{ width: '1px', height: '16px', backgroundColor: 'var(--border-color)' }} />}
                  </>
                </>
                <>
                  <button
                    onClick={() => handleQuickAction('rewrite')}
                      className="btn-icon"
                      title="Rewrite selection"
                      type="button"
                    >
                      <Sparkles size={16} style={{ color: 'var(--accent)' }} />
                    </button>
                    <button
                      onClick={() => handleQuickAction('shorten')}
                      className="btn-icon"
                      title="Shorten text"
                      type="button"
                    >
                      <ArrowDownToLine size={16} />
                    </button>
                    <button
                      onClick={() => handleQuickAction('expand')}
                      className="btn-icon"
                      title="Expand text"
                      type="button"
                    >
                      <ArrowUpFromLine size={16} />
                    </button>
                    <button
                      onClick={() => handleQuickAction('grammar')}
                      className="btn-icon"
                      title="Fix grammar & spelling"
                      type="button"
                    >
                      <Languages size={16} />
                    </button>
                </>
              </div>
            )
          })()}
        </BubbleMenu>
      )}

      {/* Editor Content Area */}
      <div className="editor-content-scroll" style={{ flex: 1, overflowY: 'auto', outline: 'none' }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
