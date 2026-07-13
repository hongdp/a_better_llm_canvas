// TipTap extension definitions used by the Editor component.
// Kept in a separate module (not Editor.tsx) so the component file only
// exports components, which is required for Vite fast refresh.
import { Mark, mergeAttributes, Extension, Node } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType
    }
    outdent: {
      outdent: () => ReturnType
    }
  }
}

export const IndentExtension = Extension.create({
  name: 'indent',

  addOptions() {
    return {
      types: ['paragraph', 'heading', 'blockquote', 'listItem'],
      indentSize: 24, // in px
      maxIndent: 8,
    }
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          marginLeft: {
            default: null,
            parseHTML: element => element.style.marginLeft || null,
            renderHTML: attributes => {
              if (!attributes.marginLeft) {
                return {}
              }
              return { style: `margin-left: ${attributes.marginLeft}` }
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      indent: () => ({ tr, state, dispatch }) => {
        let hasChanged = false
        const { selection } = state
        tr.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (this.options.types.includes(node.type.name)) {
            const currentIndent = node.attrs.marginLeft ? parseInt(String(node.attrs.marginLeft).replace('px', '')) || 0 : 0
            const nextIndent = currentIndent + this.options.indentSize
            if (nextIndent <= this.options.maxIndent * this.options.indentSize) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                marginLeft: `${nextIndent}px`,
              })
              hasChanged = true
            }
          }
        })
        if (hasChanged && dispatch) {
          dispatch(tr)
        }
        return hasChanged
      },
      outdent: () => ({ tr, state, dispatch }) => {
        let hasChanged = false
        const { selection } = state
        tr.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
          if (this.options.types.includes(node.type.name)) {
            const currentIndent = node.attrs.marginLeft ? parseInt(String(node.attrs.marginLeft).replace('px', '')) || 0 : 0
            if (currentIndent > 0) {
              const nextIndent = Math.max(0, currentIndent - this.options.indentSize)
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                marginLeft: nextIndent > 0 ? `${nextIndent}px` : null,
              })
              hasChanged = true
            }
          }
        })
        if (hasChanged && dispatch) {
          dispatch(tr)
        }
        return hasChanged
      },
    }
  },
})

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

// Custom TipTap Node Extension for Images
export const CustomImage = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      style: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  },
})

// Custom TipTap Extension to keep visual selection highlight when editor is blurred (e.g. chat input focused)
export const BlurredSelection = Extension.create({
  name: 'blurredSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blurredSelection'),
        props: {
          // Arrow function so `this` stays bound to the extension (avoids a
          // `this` alias; the plugin's own `this` is not needed here).
          decorations: (state) => {
            const editor = this.editor
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
