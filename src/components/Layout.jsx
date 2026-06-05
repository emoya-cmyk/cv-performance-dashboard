import { useState, Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'

// Lightweight content-area fallback shown while a lazy page chunk loads.
// Lives INSIDE the chrome so the sidebar stays mounted across agency-page navigation.
function ContentFallback() {
  return (
    <div className="flex items-center justify-center py-32 text-sm text-slate-400">
      <div className="h-5 w-5 mr-3 rounded-full border-2 border-slate-300 border-t-transparent animate-spin" />
      Loading…
    </div>
  )
}

export default function Layout({ store }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(p => !p)} />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-screen-xl mx-auto p-6">
          <Suspense fallback={<ContentFallback />}>
            <Outlet context={store} />
          </Suspense>
        </div>
      </main>
    </div>
  )
}
