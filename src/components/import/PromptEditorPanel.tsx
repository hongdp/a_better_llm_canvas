/**
 * Safety-block prompt editor of the import modal (status === 'prompt_edit'):
 * lets the user rewrite the failing system/user prompts before a manual
 * retry. Presentational only; retry logic lives in ImportUrlModal.
 */

import React from 'react'
import { AlertCircle } from 'lucide-react'
import type { FailedPromptContext } from '../../types/import'

interface PromptEditorPanelProps {
  failedPromptContext: FailedPromptContext | null
  editableSystemPrompt: string
  onSystemPromptChange: (value: string) => void
  editableUserPrompt: string
  onUserPromptChange: (value: string) => void
}

export const PromptEditorPanel: React.FC<PromptEditorPanelProps> = ({
  failedPromptContext,
  editableSystemPrompt,
  onSystemPromptChange,
  editableUserPrompt,
  onUserPromptChange,
}) => {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      padding: '1rem',
      backgroundColor: 'var(--bg-primary)',
      borderRadius: '8px',
      border: '1px solid var(--border-color)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f59e0b' }}>
        <AlertCircle size={18} style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>内容合规安全拦截编辑</span>
      </div>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
        当前拦截阶段为：<strong>{failedPromptContext?.phase === 1 ? 'Phase 1: 章节大纲划分' : `Phase 2: 第 ${(failedPromptContext?.chapterIndex ?? 0) + 1} 章小说创作`}</strong>。
        LLM 检测到当前 Prompt 中可能包含敏感、违规或不合规的词汇，因此拦截了该请求。
        请您在下方修改 Prompt 模板（例如剔除敏感字眼、降低尺度或重写引导语），然后点击手动重试。
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>
          System Prompt (系统提示词):
        </label>
        <textarea
          value={editableSystemPrompt}
          onChange={e => onSystemPromptChange(e.target.value)}
          style={{
            width: '100%',
            height: '100px',
            fontSize: '0.8rem',
            fontFamily: 'monospace',
            padding: '0.5rem',
            backgroundColor: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            resize: 'vertical'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>
          User Prompt (用户输入内容):
        </label>
        <textarea
          value={editableUserPrompt}
          onChange={e => onUserPromptChange(e.target.value)}
          style={{
            width: '100%',
            height: '180px',
            fontSize: '0.8rem',
            fontFamily: 'monospace',
            padding: '0.5rem',
            backgroundColor: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            resize: 'vertical'
          }}
        />
      </div>
    </div>
  )
}
