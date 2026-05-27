import { useState, useEffect } from 'react'
import { AgencyContext, fetchAgencySettings, applyBrandColor } from '@/lib/agencySettings'

const DEFAULTS = { agency_name: '10X Performance', accent_hex: '#e53935', logo_url: null }

export default function AgencyProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULTS)

  useEffect(() => {
    fetchAgencySettings().then(s => {
      if (s) {
        setSettings(s)
        applyBrandColor(s.accent_hex)
      }
    }).catch(() => {})
  }, [])

  return <AgencyContext.Provider value={settings}>{children}</AgencyContext.Provider>
}
