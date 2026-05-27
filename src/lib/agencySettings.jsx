/**
 * Agency white-label settings — fetch, cache, and apply to CSS variables.
 * React context lives here too.
 */
import { createContext, useContext, useState, useEffect } from 'react'

const BASE = import.meta.env.VITE_API_URL || ''

const DEFAULTS = {
  agency_name:   '10X Performance',
  accent_hex:    '#e53935',
  logo_url:      null,
  contact_email: null,
  calendar_url:  null,
}

// ── CSS variable injection ────────────────────────────────────────────────────
function hexToRgbTriple(hex) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b]
}

function shade(rgb, factor) {
  return rgb.map(c =>
    factor > 1
      ? Math.min(255, Math.round(c + (255 - c) * (factor - 1)))
      : Math.max(0,   Math.round(c * factor))
  )
}

export function applyBrandColor(hex) {
  const rgb = hexToRgbTriple(hex)
  if (!rgb) return
  const root = document.documentElement
  root.style.setProperty('--brand-500', rgb.join(' '))
  root.style.setProperty('--brand-600', shade(rgb, 0.88).join(' '))
  root.style.setProperty('--brand-700', shade(rgb, 0.72).join(' '))
  root.style.setProperty('--brand-100', shade(rgb, 1.75).join(' '))
  root.style.setProperty('--brand-50',  shade(rgb, 1.92).join(' '))
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
let _cached = null

export async function fetchAgencySettings() {
  if (_cached) return _cached
  try {
    const res = await fetch(`${BASE}/api/agency/settings`)
    if (res.ok) {
      _cached = await res.json()
      return _cached
    }
  } catch { /* fall through */ }
  return DEFAULTS
}

export function clearSettingsCache() { _cached = null }

// ── React context ─────────────────────────────────────────────────────────────
export const AgencyContext = createContext(DEFAULTS)

export function useAgency() { return useContext(AgencyContext) }

export function AgencyProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS)

  useEffect(() => {
    fetchAgencySettings().then(s => {
      setSettings(s)
      applyBrandColor(s.accent_hex)
    })
  }, [])

  return <AgencyContext.Provider value={settings}>{children}</AgencyContext.Provider>
}
