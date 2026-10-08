import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useTranslation } from '../i18n'
import type { AgentTurnRecord } from '../types/chat'
import type { ServerRunAction } from '../services/serverRuns'

/**
 * Under a bubble: a server-side run's queue and pause controls
 * (backend_authority.md §6.3 and "Runaway runs"), and the question a run
 * put to the user with `ask_user` — as choices and a free answer. A paused
 * server run continues with the answer; a tab-run that ended asking gets the
 * answer as the next message.
 */
export function RunControls({ record, onAction, onAnswer, disabled }: {
  record: AgentTurnRecord
  onAction: (runId: string, action: ServerRunAction) => void
  onAnswer: (record: AgentTurnRecord, answer: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const language = useAppStore(state => state.language)
  const [free, setFree] = useState('')
  const run = record.run
  const serverQuestion = run?.status === 'paused' && run.pause?.reason === 'question'
    ? { question: run.pause.question ?? run.pause.message, options: run.pause.options ?? [] }
    : null
  const question = serverQuestion ?? (record.question && !run ? record.question : null)

  if (question) {
    return (
      <div className="run-controls">
        <div className="run-controls-text">❓ {question.question}</div>
        <div className="run-controls-actions">
          {question.options.map(option => (
            <button key={option} type="button" className="agent-touched-view" disabled={disabled} onClick={() => onAnswer(record, option)}>{option}</button>
          ))}
        </div>
        <form className="run-controls-actions" onSubmit={e => { e.preventDefault(); if (free.trim()) { onAnswer(record, free.trim()); setFree('') } }}>
          <input className="form-input" value={free} disabled={disabled} placeholder={t.agent.answerPlaceholder} onChange={e => setFree(e.target.value)} />
          <button type="submit" className="agent-touched-view" disabled={disabled || !free.trim()}>{t.agent.answer}</button>
        </form>
      </div>
    )
  }

  if (!run || (run.status !== 'queued' && run.status !== 'paused')) return null
  const pause = run.pause
  const reason = pause?.reason === 'repeating' ? t.agent.pausedRepeating
    : pause?.reason === 'unattended' ? t.agent.pausedUnattended
    : pause?.reason === 'token_budget' ? t.agent.pausedBudget
    : pause?.message ?? ''
  return (
    <div className="run-controls">
      <div className="run-controls-text">
        {run.status === 'queued' ? t.agent.queued(run.position ?? 0) : `${t.agent.paused} ${reason}`}
        {run.status === 'paused' && pause?.steps && pause.steps.length > 0 && (
          <details className="run-controls-steps">
            <summary>{t.agent.pausedSteps}</summary>
            <ol>
              {pause.steps.map((s, i) => (
                <li key={i}>
                  <div>{s.calls.join(', ') || (language === 'zh' ? '（无调用）' : '(no calls)')}</div>
                  {s.reasoning && <div className="run-controls-reasoning">{s.reasoning}</div>}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
      <div className="run-controls-actions">
        {run.status === 'queued' ? (
          <>
            <button type="button" className="agent-touched-view" onClick={() => onAction(run.id, 'start')}>{t.agent.sendNow}</button>
            <button type="button" className="agent-touched-view" onClick={() => onAction(run.id, 'remove')}>{t.agent.remove}</button>
          </>
        ) : (
          <>
            <button type="button" className="agent-touched-view" onClick={() => onAction(run.id, 'resume')}>{t.agent.resume}</button>
            <button type="button" className="agent-touched-view" onClick={() => onAction(run.id, 'stop')}>{t.agent.abandon}</button>
          </>
        )}
      </div>
    </div>
  )
}
