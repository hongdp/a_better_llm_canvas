import React from 'react'
import { Swords, X, Sparkle } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

interface RoleplayBannerProps {
  onEndGame: () => void
}

/**
 * Dynamically extract all "Label: Value" stat pairs from the game state
 * document text. Works with any game format — combat RPGs (HP, Gold),
 * gal games (Affection, Mood), detective games (Clues, Reputation), etc.
 */
function extractStats(gameStateText: string): { label: string; value: string }[] {
  const stats: { label: string; value: string }[] = []
  // Skip header lines like "Game State" or empty lines
  const skipLabels = new Set(['game state', 'character', ''])

  // Match lines like "Label: value" — handles both plain text and
  // text that was stripped from <strong>Label:</strong> HTML
  const lines = gameStateText.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    // Match "SomeLabel: some value"
    const match = trimmed.match(/^([A-Za-z\s\-/]+?):\s*(.+)$/)
    if (match) {
      const label = match[1].trim()
      const value = match[2].trim()
      if (!skipLabels.has(label.toLowerCase()) && value) {
        stats.push({ label, value })
      }
    }
  }
  return stats
}

export const RoleplayBanner: React.FC<RoleplayBannerProps> = ({ onEndGame }) => {
  const { roleplayConfig, documents } = useAppStore()

  if (!roleplayConfig) return null

  // Parse game state document — strip HTML to plain text, then extract stats
  const gameStateDoc = documents.find(d => d.id === roleplayConfig.gameStateDocId)
  const gameStateText = gameStateDoc?.content?.replace(/<[^>]*>?/gm, '') || ''
  const stats = extractStats(gameStateText)

  // Show up to 4 stats in the banner to keep it compact
  const displayStats = stats.slice(0, 4)

  return (
    <div className="rp-banner">
      <div className="rp-banner-info">
        <div className="rp-banner-character">
          <Swords size={14} />
          <span className="rp-banner-name">{roleplayConfig.characterName}</span>
          <span className="rp-banner-genre">{roleplayConfig.genre}</span>
        </div>
        {displayStats.length > 0 && (
          <div className="rp-banner-stats">
            {displayStats.map((stat, idx) => (
              <span key={idx} className="rp-stat" title={stat.label}>
                <Sparkle size={9} />
                <strong style={{ marginRight: '0.15rem' }}>{stat.label}:</strong>
                {stat.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        onClick={onEndGame}
        className="rp-banner-end-btn"
        title="End roleplay session"
        type="button"
      >
        <X size={12} />
        End
      </button>
    </div>
  )
}
