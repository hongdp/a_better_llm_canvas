/**
 * Convert structured TipTap HTML to clean Markdown text.
 */
export function htmlToMarkdown(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  
  function convertNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }
    
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return ''
    }
    
    const element = node as HTMLElement
    const tagName = element.tagName.toUpperCase()
    
    let childrenContent = ''
    element.childNodes.forEach((child) => {
      childrenContent += convertNode(child)
    })
    
    switch (tagName) {
      case 'H1':
        return `# ${childrenContent}\n\n`
      case 'H2':
        return `## ${childrenContent}\n\n`
      case 'H3':
        return `### ${childrenContent}\n\n`
      case 'H4':
        return `#### ${childrenContent}\n\n`
      case 'P':
        return `${childrenContent}\n\n`
      case 'STRONG':
      case 'B':
        return `**${childrenContent}**`
      case 'EM':
      case 'I':
        return `*${childrenContent}*`
      case 'BLOCKQUOTE':
        return childrenContent
          .split('\n')
          .map((line) => line ? `> ${line}` : '>')
          .join('\n') + '\n\n'
      case 'PRE':
        // TipTap pre usually wraps code
        return `\`\`\`\n${element.innerText || childrenContent}\n\`\`\`\n\n`
      case 'CODE':
        if (element.parentElement?.tagName.toUpperCase() === 'PRE') {
          return childrenContent
        }
        return `\`${childrenContent}\``
      case 'UL':
        return `${childrenContent}\n`
      case 'OL':
        return `${childrenContent}\n`
      case 'LI': {
        const parentTag = element.parentElement?.tagName.toUpperCase()
        if (parentTag === 'OL') {
          const index = Array.from(element.parentElement!.children).indexOf(element) + 1
          return `${index}. ${childrenContent}\n`
        }
        return `- ${childrenContent}\n`
      }
      case 'BR':
        return '\n'
      case 'HR':
        return '---\n\n'
      case 'INS':
        return childrenContent // Keep additions normally
      case 'DEL':
        return '' // Exclude deletions from final markdown representation
      default:
        return childrenContent
    }
  }
  
  let markdown = ''
  doc.body.childNodes.forEach((child) => {
    markdown += convertNode(child)
  })
  
  return markdown.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Convert TipTap HTML to formatted Plain Text.
 */
export function htmlToPlainText(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  
  // Strip deletion marks to prevent them appearing in plain text export
  const dels = doc.querySelectorAll('del')
  dels.forEach((del) => del.remove())
  
  return doc.body.innerText || doc.body.textContent || ''
}

/**
 * Helper to escape HTML characters to prevent XSS and tag breakout.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Convert inline markdown syntax (bold, italic, code) to HTML tags.
 */
function parseInlineMarkdown(text: string): string {
  let escaped = escapeHtml(text)
  
  // Bold: **text** or __text__
  escaped = escaped.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>')
  
  // Italic: *text* or _text_
  escaped = escaped.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>')
  
  // Inline Code: `code`
  escaped = escaped.replace(/`(.*?)`/g, '<code>$1</code>')
  
  return escaped
}

/**
 * Convert Markdown text to structured HTML for TipTap compatibility.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let inList = false
  let listType: 'ul' | 'ol' | null = null
  let inBlockquote = false
  let inCodeBlock = false
  let codeContent: string[] = []
  let paragraphLines: string[] = []

  function flushParagraph() {
    if (paragraphLines.length > 0) {
      const content = paragraphLines.join(' ')
      if (content.trim()) {
        html += `<p>${parseInlineMarkdown(content)}</p>`
      }
      paragraphLines = []
    }
  }

  function flushList() {
    if (inList && listType) {
      html += `</${listType}>`
      inList = false
      listType = null
    }
  }

  function flushBlockquote() {
    if (inBlockquote) {
      html += '</blockquote>'
      inBlockquote = false
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmedLine = line.trim()

    // 1. Handle Code Blocks
    if (trimmedLine.startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        const escapedCode = escapeHtml(codeContent.join('\n'))
        html += `<pre><code>${escapedCode}</code></pre>`
        inCodeBlock = false
        codeContent = []
      } else {
        flushList()
        flushBlockquote()
        flushParagraph()
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeContent.push(line)
      continue
    }

    // 2. Handle Blockquotes
    if (trimmedLine.startsWith('>')) {
      if (!inBlockquote) {
        flushList()
        flushParagraph()
        html += '<blockquote>'
        inBlockquote = true
      }
      const quoteText = line.substring(line.indexOf('>') + 1).replace(/^ /, '')
      paragraphLines.push(quoteText)
      continue
    } else if (inBlockquote && !trimmedLine.startsWith('>')) {
      flushParagraph()
      flushBlockquote()
    }

    // 3. Handle Horizontal Rules
    if (trimmedLine === '---' || trimmedLine === '***' || trimmedLine === '___') {
      flushList()
      flushBlockquote()
      flushParagraph()
      html += '<hr />'
      continue
    }

    // 4. Handle Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      flushList()
      flushBlockquote()
      flushParagraph()
      const level = headingMatch[1].length
      const title = headingMatch[2]
      html += `<h${level}>${parseInlineMarkdown(title)}</h${level}>`
      continue
    }

    // 5. Handle Lists
    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/)
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/)

    if (ulMatch) {
      flushParagraph()
      if (inList && listType !== 'ul') {
        flushList()
      }
      if (!inList) {
        html += '<ul>'
        inList = true
        listType = 'ul'
      }
      html += `<li>${parseInlineMarkdown(ulMatch[1])}</li>`
      continue
    }

    if (olMatch) {
      flushParagraph()
      if (inList && listType !== 'ol') {
        flushList()
      }
      if (!inList) {
        html += '<ol>'
        inList = true
        listType = 'ol'
      }
      html += `<li>${parseInlineMarkdown(olMatch[1])}</li>`
      continue
    }

    // Empty lines act as block delimiters
    if (trimmedLine === '') {
      flushList()
      flushBlockquote()
      flushParagraph()
      continue
    }

    // Regular line, accumulate in paragraph
    paragraphLines.push(trimmedLine)
  }

  // Final flushes
  if (inCodeBlock) {
    const escapedCode = escapeHtml(codeContent.join('\n'))
    html += `<pre><code>${escapedCode}</code></pre>`
  }
  flushList()
  flushBlockquote()
  flushParagraph()

  return html
}

/**
 * Convert Plain Text to formatted HTML paragraphs.
 */
export function txtToHtml(text: string): string {
  const escaped = escapeHtml(text)
  return escaped
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('\n')
}

/**
 * Sanitize untrusted HTML inputs client-side to prevent XSS.
 */
export function sanitizeHtml(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  
  // Remove script tags
  const scripts = doc.querySelectorAll('script')
  scripts.forEach((s) => s.remove())
  
  // Remove inline handlers and javascript: URIs
  const allElements = doc.querySelectorAll('*')
  allElements.forEach((el) => {
    const attrs = Array.from(el.attributes)
    attrs.forEach((attr) => {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name)
      }
    })
  })
  
  return doc.body.innerHTML
}

