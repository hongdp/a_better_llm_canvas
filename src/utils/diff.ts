interface DiffItem {
  type: 'equal' | 'insert' | 'delete'
  value: string
}

/**
 * Checks if a token is an HTML tag.
 */
function isTag(token: string): boolean {
  return token.startsWith('<') && token.endsWith('>')
}

/**
 * Runs the Longest Common Subsequence (LCS) algorithm to find the edits.
 * Since prefix/suffix optimization is applied first, the inputs here are typically small.
 */
function computeLcs(X: string[], Y: string[]): DiffItem[] {
  const m = X.length
  const n = Y.length
  
  // DP Table for LCS lengths
  const L: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      if (i === 0 || j === 0) {
        L[i][j] = 0
      } else if (X[i - 1] === Y[j - 1]) {
        L[i][j] = L[i - 1][j - 1] + 1
      } else {
        L[i][j] = Math.max(L[i - 1][j], L[i][j - 1])
      }
    }
  }

  // Backtrack to find the diff path
  let i = m
  let j = n
  const result: DiffItem[] = []

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && X[i - 1] === Y[j - 1]) {
      result.push({ type: 'equal', value: X[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || L[i][j - 1] >= L[i - 1][j])) {
      result.push({ type: 'insert', value: Y[j - 1] })
      j--
    } else {
      result.push({ type: 'delete', value: X[i - 1] })
      i--
    }
  }

  return result.reverse()
}

/**
 * Diff two HTML strings token-by-token and render a merged HTML containing <ins> and <del> tags.
 */
export function diffHtml(oldHtml: string, newHtml: string): string {
  // Tokenize: Matches HTML tags (<p>, </h1>), words (Hello, text), or whitespaces (\n, spaces)
  const tokenRegex = /(<[^>]+>|[^\s<]+|\s+)/g
  const oldTokens = oldHtml.match(tokenRegex) || []
  const newTokens = newHtml.match(tokenRegex) || []

  // 1. Prefix Optimization
  let prefixCount = 0
  while (
    prefixCount < oldTokens.length &&
    prefixCount < newTokens.length &&
    oldTokens[prefixCount] === newTokens[prefixCount]
  ) {
    prefixCount++
  }

  // 2. Suffix Optimization
  let suffixCount = 0
  while (
    suffixCount < oldTokens.length - prefixCount &&
    suffixCount < newTokens.length - prefixCount &&
    oldTokens[oldTokens.length - 1 - suffixCount] === newTokens[newTokens.length - 1 - suffixCount]
  ) {
    suffixCount++
  }

  const prefixTokens = oldTokens.slice(0, prefixCount)
  const suffixTokens = oldTokens.slice(oldTokens.length - suffixCount)
  
  const middleOld = oldTokens.slice(prefixCount, oldTokens.length - suffixCount)
  const middleNew = newTokens.slice(prefixCount, newTokens.length - suffixCount)

  // 3. Compute LCS on the changed middle region
  const middleDiff = computeLcs(middleOld, middleNew)

  // 4. Assemble full token sequence
  const fullDiff: DiffItem[] = [
    ...prefixTokens.map(tok => ({ type: 'equal' as const, value: tok })),
    ...middleDiff,
    ...suffixTokens.map(tok => ({ type: 'equal' as const, value: tok }))
  ]

  // 5. Render to HTML with custom ins/del wrappers and grouped IDs
  let html = ''
  let idx = 0

  while (idx < fullDiff.length) {
    const item = fullDiff[idx]

    if (item.type === 'equal') {
      html += item.value
      idx++
    } else {
      // Transitioned into a change range -> generate a unique group ID
      const diffId = `diff-${Math.random().toString(36).substring(2, 9)}`
      
      const deletedTokens: string[] = []
      const insertedTokens: string[] = []

      // Collect contiguous deletes and inserts
      while (idx < fullDiff.length && fullDiff[idx].type !== 'equal') {
        const current = fullDiff[idx]
        if (current.type === 'delete') {
          deletedTokens.push(current.value)
        } else if (current.type === 'insert') {
          insertedTokens.push(current.value)
        }
        idx++
      }

      // Format deleted content: extract text only, ignore tags to prevent structural breakages
      const deletedText = deletedTokens
        .filter(t => !isTag(t))
        .join('')

      // Format inserted content: output HTML tags as-is and wrap text nodes in <ins>
      let insertedHtml = ''
      let currentInsertText = ''

      const flushInsertText = () => {
        if (currentInsertText) {
          insertedHtml += `<ins class="diff-addition" data-diff-id="${diffId}">${currentInsertText}</ins>`
          currentInsertText = ''
        }
      }

      insertedTokens.forEach(token => {
        if (isTag(token)) {
          flushInsertText()
          insertedHtml += token
        } else {
          currentInsertText += token
        }
      })
      flushInsertText()

      // Output deletions (<del>) then insertions (<ins>)
      if (deletedText) {
        html += `<del class="diff-deletion" data-diff-id="${diffId}">${deletedText}</del>`
      }
      if (insertedHtml) {
        html += insertedHtml
      }
    }
  }

  return html
}
