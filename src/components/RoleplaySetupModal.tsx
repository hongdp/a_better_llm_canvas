import React, { useState } from 'react'
import { X, Swords, Sparkles } from 'lucide-react'

interface RoleplaySetupModalProps {
  isOpen: boolean
  onClose: () => void
  onStartGame: (config: {
    characterName: string
    genre: string
    difficulty: 'easy' | 'normal' | 'hard'
    customWorldDesc?: string
  }) => void
}

const GENRES = [
  { value: 'Fantasy', emoji: '🧙' },
  { value: 'Sci-Fi', emoji: '🚀' },
  { value: 'Horror', emoji: '👻' },
  { value: 'Mystery', emoji: '🔍' },
  { value: 'Post-Apocalyptic', emoji: '☢️' },
  { value: 'Superhero', emoji: '🦸' },
  { value: 'Historical', emoji: '🏛️' },
  { value: 'Steampunk', emoji: '⚙️' },
  { value: 'Custom', emoji: '✨' },
] as const

const DIFFICULTIES = [
  {
    value: 'easy' as const,
    label: '🌿 Easy',
    description: 'Forgiving encounters, helpful hints, and generous checkpoints. Great for story-focused play.',
  },
  {
    value: 'normal' as const,
    label: '⚖️ Normal',
    description: 'Balanced challenge with fair consequences. Your choices matter.',
  },
  {
    value: 'hard' as const,
    label: '💀 Hard',
    description: 'Punishing difficulty — permadeath possible, scarce resources, no mercy.',
  },
] as const

export const RoleplaySetupModal: React.FC<RoleplaySetupModalProps> = ({
  isOpen,
  onClose,
  onStartGame,
}) => {
  const [characterName, setCharacterName] = useState('')
  const [genre, setGenre] = useState('Fantasy')
  const [difficulty, setDifficulty] = useState<'easy' | 'normal' | 'hard'>('normal')
  const [customWorldDesc, setCustomWorldDesc] = useState('')

  if (!isOpen) return null

  const isCustomGenre = genre === 'Custom'

  const handleStart = () => {
    if (!characterName.trim()) return
    // Custom genre requires a game setting description
    if (isCustomGenre && !customWorldDesc.trim()) return
    onStartGame({
      characterName: characterName.trim(),
      genre,
      difficulty,
      customWorldDesc: customWorldDesc.trim() || undefined,
    })
  }

  const selectedDifficultyInfo = DIFFICULTIES.find(d => d.value === difficulty)

  return (
    <div className="rp-modal-overlay" onClick={onClose}>
      <div className="rp-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="rp-modal-header">
          <h2>
            <Swords size={18} style={{ color: '#a78bfa' }} />
            New Roleplay Adventure
          </h2>
          <button onClick={onClose} className="btn-icon" title="Close" type="button">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="rp-modal-body">
          {/* Character Name */}
          <div className="rp-field-group">
            <label className="rp-field-label" htmlFor="rp-character-name">
              <Sparkles size={12} style={{ color: '#a78bfa', display: 'inline' }} />{' '}
              Character Name <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              id="rp-character-name"
              type="text"
              value={characterName}
              onChange={e => setCharacterName(e.target.value)}
              placeholder="Enter your character's name..."
              className="rp-text-input"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleStart() }}
            />
          </div>

          {/* Genre */}
          <div className="rp-field-group">
            <label className="rp-field-label" htmlFor="rp-genre-select">Genre</label>
            <select
              id="rp-genre-select"
              value={genre}
              onChange={e => setGenre(e.target.value)}
              className="rp-text-input"
              style={{ cursor: 'pointer' }}
            >
              {GENRES.map(g => (
                <option key={g.value} value={g.value}>
                  {g.emoji} {g.value}
                </option>
              ))}
            </select>
          </div>

          {/* Difficulty */}
          <div className="rp-field-group">
            <label className="rp-field-label">Difficulty</label>
            <div className="rp-difficulty-options">
              {DIFFICULTIES.map(d => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDifficulty(d.value)}
                  className={`rp-difficulty-btn ${difficulty === d.value ? 'active' : ''}`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {selectedDifficultyInfo && (
              <div className="rp-difficulty-desc">
                {selectedDifficultyInfo.description}
              </div>
            )}
          </div>

          {/* Game Setting / Custom World Description */}
          <div className="rp-field-group">
            <label className="rp-field-label" htmlFor="rp-world-desc">
              {isCustomGenre ? (
                <>
                  Game Setting <span style={{ color: '#ef4444' }}>*</span>
                </>
              ) : (
                <>
                  Custom World Description{' '}
                  <span style={{ fontWeight: 400, fontSize: '0.72rem', opacity: 0.7 }}>(optional)</span>
                </>
              )}
            </label>
            {isCustomGenre && (
              <div style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                lineHeight: 1.45,
                marginBottom: '0.3rem',
                padding: '0.4rem 0.6rem',
                borderRadius: '6px',
                background: 'rgba(124, 58, 237, 0.06)',
                border: '1px solid rgba(124, 58, 237, 0.12)',
              }}>
                Describe your game world, rules, and setting. The GM will build the adventure based on your description. Include things like: theme, setting, available abilities, key factions, tone, or any game mechanics you want.
              </div>
            )}
            <textarea
              id="rp-world-desc"
              value={customWorldDesc}
              onChange={e => setCustomWorldDesc(e.target.value)}
              placeholder={isCustomGenre
                ? 'Example: "A noir detective story set in 1920s Chicago. The player is a private investigator with a troubled past. Magic exists but is illegal and hidden underground. Factions include the corrupt police, the Italian mob, and a secret society of mages. Use a gritty, hard-boiled tone. Track clues and reputation instead of HP."'
                : 'Describe additional world-building details, lore, or setting specifics...'
              }
              className="rp-text-input rp-textarea"
              rows={isCustomGenre ? 6 : 3}
              style={isCustomGenre ? { minHeight: '120px' } : undefined}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="rp-modal-footer">
          <button onClick={onClose} className="rp-cancel-btn" type="button">
            Cancel
          </button>
          <button
            onClick={handleStart}
            className="rp-start-btn"
            type="button"
            disabled={!characterName.trim() || (isCustomGenre && !customWorldDesc.trim())}
          >
            <Swords size={15} />
            Start Adventure
          </button>
        </div>
      </div>
    </div>
  )
}
