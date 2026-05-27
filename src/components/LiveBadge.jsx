/**
 * LiveBadge — shows a pulsing "Live" dot or "Refreshing…" spinner
 * when data is being fetched.
 */
export default function LiveBadge({ loading, lastRefresh }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        Refreshing…
      </span>
    )
  }
  if (lastRefresh) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        Live
      </span>
    )
  }
  return null
}
