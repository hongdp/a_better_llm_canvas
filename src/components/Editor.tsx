import React, { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
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
  Quote
} from 'lucide-react'

interface EditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
}

export const Editor: React.FC<EditorProps> = ({ 
  content, 
  onChange, 
  placeholder = 'Start writing your document here or let the assistant draft it...' 
}) => {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder,
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
  })

  // Synchronize incoming content updates (e.g. from LLM streaming) with TipTap
  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content, { emitUpdate: false })
    }
  }, [content, editor])

  // Prevent rendering if editor is not initialized
  if (!editor) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
        Loading document editor...
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Floating Bubble Menu for Text Selection */}
      {editor && (
        <BubbleMenu 
          editor={editor} 
          updateDelay={100}
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
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`btn-icon ${editor.isActive('bold') ? 'active' : ''}`}
            title="Bold"
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
            title="Italic"
            type="button"
            style={{
              backgroundColor: editor.isActive('italic') ? 'var(--bg-tertiary)' : 'transparent',
              color: editor.isActive('italic') ? 'var(--accent)' : 'inherit',
            }}
          >
            <Italic size={16} />
          </button>
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
          <button
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={`btn-icon ${editor.isActive('blockquote') ? 'active' : ''}`}
            title="Quote"
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
        </BubbleMenu>
      )}

      {/* Editor Content Area */}
      <EditorContent editor={editor} style={{ outline: 'none' }} />
    </div>
  )
}
