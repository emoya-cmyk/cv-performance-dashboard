import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import RequireAuth    from '@/components/RequireAuth'
import Layout         from '@/components/Layout'
import Login          from '@/pages/Login'   // eager — unauthenticated entry; smallest possible first paint
import { useStore }      from '@/data/useStore'
import { getUser }       from '@/lib/auth'
import { USE_API }       from '@/lib/api'
import { AgencyProvider } from '@/lib/agencySettings'

// Every authenticated page is code-split so the entry chunk ships only the shell + login.
// recharts (used by ~10 of these) and the heavy Intelligence/Explore pages now load on demand.
const Dashboard      = lazy(() => import('@/pages/Dashboard'))
const GoogleAds      = lazy(() => import('@/pages/GoogleAds'))
const LSAPerformance = lazy(() => import('@/pages/LSAPerformance'))
const MetaAds        = lazy(() => import('@/pages/MetaAds'))
const GBPInsights    = lazy(() => import('@/pages/GBPInsights'))
const LeadFunnel     = lazy(() => import('@/pages/LeadFunnel'))
const Clients        = lazy(() => import('@/pages/Clients'))
const Connections    = lazy(() => import('@/pages/Connections'))
const ClientView     = lazy(() => import('@/pages/ClientView'))
const ExecView       = lazy(() => import('@/pages/ExecView'))
const GA4Insights    = lazy(() => import('@/pages/GA4Insights'))
const SharedReport   = lazy(() => import('@/pages/SharedReport'))
const Settings       = lazy(() => import('@/pages/Settings'))
const Explore        = lazy(() => import('@/pages/Explore'))
const Intelligence   = lazy(() => import('@/pages/Intelligence'))
const SEO            = lazy(() => import('@/pages/SEO'))
const CallPrep       = lazy(() => import('@/pages/CallPrep'))
const Goals          = lazy(() => import('@/pages/Goals'))
const PhoneCalls     = lazy(() => import('@/pages/PhoneCalls'))
const JobManagement  = lazy(() => import('@/pages/JobManagement'))
const BingAds        = lazy(() => import('@/pages/BingAds'))
const PulseDiagnosisPreview = lazy(() => import('@/pages/PulseDiagnosisPreview'))   // design preview only — /pulse-preview, no auth

// Full-viewport fallback for full-bleed routes (login-adjacent surfaces with no chrome)
function FullPageFallback() {
  return (
    <div className="flex items-center justify-center h-screen text-sm text-slate-400">
      <div className="h-5 w-5 mr-3 rounded-full border-2 border-slate-300 border-t-transparent animate-spin" />
      Loading…
    </div>
  )
}

// Loads the store only after auth passes — keeps it off the login page entirely
function AuthenticatedApp() {
  const store = useStore()

  function AgencyIndex() {
    if (USE_API && getUser()?.role === 'client') return <Navigate to="/my-dashboard" replace />
    return <Dashboard />
  }

  // Outer boundary catches the full-bleed routes below (/my-dashboard, /exec, /shared).
  // Layout adds its own inner <Suspense> so agency pages swap WITHOUT unmounting the sidebar.
  return (
    <Suspense fallback={<FullPageFallback />}>
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
        <Route path="/seo"            element={<SEO />} />
        <Route path="/call-prep"      element={<CallPrep />} />
        <Route path="/phone-calls"    element={<PhoneCalls />} />
        <Route path="/jobs"           element={<JobManagement />} />
        <Route path="/bing-ads"       element={<BingAds />} />
        <Route path="/goals"          element={<Goals />} />
        <Route path="/settings"       element={<Settings />} />
        <Route path="*"               element={<Navigate to="/" replace />} />
      </Route>
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <AgencyProvider>
      <BrowserRouter>
        {/* Safety-net boundary so the lazy /pulse-preview route (and any first-load chunk) has a fallback. */}
        <Suspense fallback={<FullPageFallback />}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/pulse-preview" element={<PulseDiagnosisPreview />} />
            <Route path="/*" element={<RequireAuth><AuthenticatedApp /></RequireAuth>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AgencyProvider>
  )
}
