import React, { useEffect } from 'react'
import { useEditor, EditorContent, Mark, mergeAttributes, Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { 
  Bold, 
  Italic, 
  Heading1, 
  Heading2, 
  List, 
  ListOrdered, 
  Code,
  Quote,
  Check,
  X,
  Sparkles,
  ArrowDownToLine,
  ArrowUpFromLine,
  Languages
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

// Custom TipTap Mark Extension for Proposed Additions (<ins>)
export const DiffAddition = Mark.create({
  name: 'diffAddition',
  addAttributes() {
    return {
      'data-diff-id': {
        default: null,
        parseHTML: element => element.getAttribute('data-diff-id'),
        renderHTML: attributes => {
          if (!attributes['data-diff-id']) return {}
          return { 'data-diff-id': attributes['data-diff-id'] }
        }
      }
    }
  },
  parseHTML() {
    return [{ tag: 'ins' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'diff-addition' }), 0]
  }
})

// Custom TipTap Mark Extension for Proposed Deletions (<del>)
export const DiffDeletion = Mark.create({
  name: 'diffDeletion',
  addAttributes() {
    return {
      'data-diff-id': {
        default: null,
        parseHTML: element => element.getAttribute('data-diff-id'),
        renderHTML: attributes => {
          if (!attributes['data-diff-id']) return {}
          return { 'data-diff-id': attributes['data-diff-id'] }
        }
      }
    }
  },
  parseHTML() {
    return [{ tag: 'del' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'diff-deletion' }), 0]
  }
})

// Custom TipTap Extension to keep visual selection highlight when editor is blurred (e.g. chat input focused)
export const BlurredSelection = Extension.create({
  name: 'blurredSelection',

  addProseMirrorPlugins() {
    const extensionThis = this
    return [
      new Plugin({
        key: new PluginKey('blurredSelection'),
        props: {
          decorations(state) {
            const editor = extensionThis.editor
            if (editor && !editor.isFocused) {
              const { from, to, empty } = state.selection
              if (!empty) {
                return DecorationSet.create(state.doc, [
                  Decoration.inline(from, to, {
                    class: 'blurred-selection-highlight'
                  })
                ])
              }
            }
            return DecorationSet.empty
          }
        }
      })
    ]
  }
})

interface EditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  onQuickAction?: (action: 'rewrite' | 'shorten' | 'expand' | 'grammar') => void
}

export const Editor: React.FC<EditorProps> = ({ 
  content, 
  onChange, 
  placeholder = 'Start writing your document here or let the assistant draft it...',
  onQuickAction
}) => {
  const { setSelectedText, setActiveEditor } = useAppStore()

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
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
    onSelectionUpdate: ({ editor }) => {
      const { from, to, empty } = editor.state.selection
      if (empty) {
        setSelectedText('')
      } else {
        const text = editor.state.doc.textBetween(from, to, ' ')
        setSelectedText(text)
      }
    }
  })

  // Synchronize incoming content updates (e.g. from LLM streaming) with TipTap
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false })
    }
  }, [content, editor])

  // Sync editor reference globally for bulk actions
  useEffect(() => {
    if (editor) {
      setActiveEditor(editor)
    }
    return () => {
      setActiveEditor(null)
    }
  }, [editor, setActiveEditor])

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
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', position: 'relative' }}>
      {/* Fixed Formatting Toolbar */}
      {editor && (
        <div className="editor-toolbar" style={{
          display: 'flex',
          gap: '6px',
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-color)',
          alignItems: 'center',
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backgroundColor: 'var(--bg-glass)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}>
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
            if (!onQuickAction) return null

            return (
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <button
                  onClick={() => onQuickAction('rewrite')}
                  className="btn-icon"
                  title="Rewrite selection"
                  type="button"
                >
                  <Sparkles size={16} style={{ color: 'var(--accent)' }} />
                </button>
                <button
                  onClick={() => onQuickAction('shorten')}
                  className="btn-icon"
                  title="Shorten text"
                  type="button"
                >
                  <ArrowDownToLine size={16} />
                </button>
                <button
                  onClick={() => onQuickAction('expand')}
                  className="btn-icon"
                  title="Expand text"
                  type="button"
                >
                  <ArrowUpFromLine size={16} />
                </button>
                <button
                  onClick={() => onQuickAction('grammar')}
                  className="btn-icon"
                  title="Fix grammar & spelling"
                  type="button"
                >
                  <Languages size={16} />
                </button>
              </div>
            )
          })()}
        </BubbleMenu>
      )}

      {/* Editor Content Area */}
      <EditorContent editor={editor} style={{ outline: 'none' }} />
    </div>
  )
}
