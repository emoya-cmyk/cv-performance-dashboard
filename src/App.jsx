import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import RequireAuth    from '@/components/RequireAuth'
import Layout         from '@/components/Layout'
import Login          from '@/pages/Login'
import Dashboard      from '@/pages/Dashboard'
import GoogleAds      from '@/pages/GoogleAds'
import LSAPerformance from '@/pages/LSAPerformance'
import MetaAds        from '@/pages/MetaAds'
import GBPInsights    from '@/pages/GBPInsights'
import LeadFunnel     from '@/pages/LeadFunnel'
import Clients        from '@/pages/Clients'
import Connections    from '@/pages/Connections'
import ClientView     from '@/pages/ClientView'
import ExecView       from '@/pages/ExecView'
import GA4Insights    from '@/pages/GA4Insights'
import SharedReport   from '@/pages/SharedReport'
import Settings       from '@/pages/Settings'
import Explore        from '@/pages/Explore'
import Intelligence   from '@/pages/Intelligence'
import PulseDiagnosisPreview from '@/pages/PulseDiagnosisPreview'   // design preview only — /pulse-preview, no auth
import { useStore }      from '@/data/useStore'
import { getUser }       from '@/lib/auth'
import { USE_API }       from '@/lib/api'
import { AgencyProvider } from '@/lib/agencySettings'

// Loads the store only after auth passes — keeps it off the login page entirely
function AuthenticatedApp() {
  const store = useStore()

  function AgencyIndex() {
    if (USE_API && getUser()?.role === 'client') return <Navigate to="/my-dashboard" replace />
    return <Dashboard />
  }

  return (
    <Routes>
      <Route path="/my-dashboard"    element={<ClientView store={store} />} />
      <Route path="/exec"            element={<ExecView store={store} />} />
      <Route path="/shared/:token"   element={<SharedReport />} />
      <Route element={<Layout store={store} />}>
        <Route index                  element={<AgencyIndex />} />
        <Route path="/google-ads"     element={<GoogleAds />} />
        <Route path="/lsa"            element={<LSAPerformance />} />
        <Route path="/meta"           element={<MetaAds />} />
        <Route path="/gbp"            element={<GBPInsights />} />
        <Route path="/ga4"            element={<GA4Insights />} />
        <Route path="/funnel"         element={<LeadFunnel />} />
        <Route path="/explore"        element={<Explore />} />
        <Route path="/intelligence"   element={<Intelligence />} />
        <Route path="/clients"        element={<Clients />} />
        <Route path="/connections"    element={<Connections />} />
        <Route path="/settings"       element={<Settings />} />
        <Route path="*"               element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AgencyProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/pulse-preview" element={<PulseDiagnosisPreview />} />
          <Route path="/*" element={<RequireAuth><AuthenticatedApp /></RequireAuth>} />
        </Routes>
      </BrowserRouter>
    </AgencyProvider>
  )
}
