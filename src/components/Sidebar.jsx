import { NavLink, Link } from 'react-router-dom'
import {
  LayoutDashboard, Megaphone, MapPin, Filter,
  Users, Plug, ChevronLeft, ChevronRight, TrendingUp, Facebook, Search, Smartphone, Presentation, Settings, Globe, Compass, Brain, BarChart2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgency } from '@/lib/agencySettings'

const NAV = [
  { to: '/',            icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/google-ads',  icon: Search,          label: 'Google Ads' },
  { to: '/lsa',         icon: Megaphone,       label: 'LSA' },
  { to: '/meta',        icon: Facebook,        label: 'Meta Ads' },
  { to: '/gbp',         icon: MapPin,          label: 'GBP Insights' },
  { to: '/ga4',         icon: Globe,           label: 'GA4 / Web' },
  { to: '/funnel',      icon: Filter,          label: 'Lead Pipeline' },
  { to: '/explore',     icon: Compass,         label: 'Explore' },
  { to: '/intelligence', icon: Brain,          label: 'Intelligence' },
  { to: '/seo',          icon: BarChart2,       label: 'SEO' },
  { to: '/clients',     icon: Users,           label: 'Clients' },
  { to: '/connections', icon: Plug,            label: 'Connections' },
  { to: '/settings',    icon: Settings,        label: 'Settings' },
]

export default function Sidebar({ collapsed, onToggle }) {
  const { agency_name, accent_hex, logo_url } = useAgency()

  return (
    <aside
      className={cn(
        'flex flex-col h-screen bg-navy-900 text-white transition-all duration-300 shrink-0',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Logo */}
      <div className={cn(
        'flex items-center gap-3 px-4 py-5 border-b border-white/10',
        collapsed && 'justify-center px-0',
      )}>
        {logo_url ? (
          <img src={logo_url} alt="logo" className="w-8 h-8 rounded-lg object-contain bg-white/10 p-0.5 shrink-0" />
        ) : (
          <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center shrink-0">
            <TrendingUp className="w-4 h-4 text-white" />
          </div>
        )}
        {!collapsed && (
          <div className="leading-tight min-w-0">
            <p className="text-xs font-black tracking-wide text-brand-500 uppercase truncate" style={{ maxWidth: 140 }}>
              {agency_name}
            </p>
            <p className="text-[11px] text-slate-400 font-medium">Dashboard</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 space-y-0.5 px-2 overflow-y-auto">
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) => cn(
              'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
              isActive
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white hover:bg-white/10',
              collapsed && 'justify-center px-0',
            )}
            title={collapsed ? label : undefined}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {!collapsed && <span>{label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Quick-launch views */}
      <div className={cn('px-2 pb-1 space-y-1', collapsed && 'px-1')}>
        <Link
          to="/exec"
          className={cn(
            'flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-black transition-colors',
            'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80 border border-white/10',
            collapsed && 'justify-center px-0',
          )}
          title="Exec Summary"
        >
          <Presentation className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Exec Summary ↗</span>}
        </Link>
        <Link
          to="/my-dashboard"
          className={cn(
            'flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-black transition-colors',
            'bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 hover:text-brand-300 border border-brand-500/20',
            collapsed && 'justify-center px-0',
          )}
          title="Client View"
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Client View ↗</span>}
        </Link>
      </div>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        className="flex items-center justify-center m-3 mt-0 p-2 rounded-xl text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
      >
        {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </aside>
  )
}
