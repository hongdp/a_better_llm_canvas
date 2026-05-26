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
