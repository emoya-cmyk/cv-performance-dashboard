/**
 * Loading skeleton components.
 * SkeletonCard — single pulsing card placeholder.
 * SkeletonGrid — row of N skeleton cards.
 */

export function SkeletonCard() {
  return (
    <div className="card animate-pulse">
      <div className="h-3 bg-white/10 rounded w-1/3 mb-3" />
      <div className="h-8 bg-white/10 rounded w-2/3 mb-2" />
      <div className="h-2 bg-white/5 rounded w-1/2" />
    </div>
  )
}

export function SkeletonGrid({ count = 4 }) {
  return (
    <div className={`grid grid-cols-2 lg:grid-cols-${count} gap-4 p-6`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

export default SkeletonCard
