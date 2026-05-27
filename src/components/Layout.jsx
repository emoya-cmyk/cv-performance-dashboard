import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'

export default function Layout({ store }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(p => !p)} />
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-screen-xl mx-auto p-6">
          <Outlet context={store} />
        </div>
      </main>
    </div>
  )
}
