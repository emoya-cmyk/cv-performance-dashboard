/**
 * Sparkline — tiny SVG polyline for KPI card trend indicators.
 * Props:
 *   values  — array of numbers (ascending time order)
 *   color   — stroke colour string (default: brand CSS var)
 *   width   — SVG width in px   (default: 72)
 *   height  — SVG height in px  (default: 24)
 */
export default function Sparkline({ values = [], color, width = 72, height = 24 }) {
  if (!values || values.length < 2) return null

  const min   = Math.min(...values)
  const max   = Math.max(...values)
  const range = max - min || 1
  const pad   = 2 // padding px so stroke doesn't clip at edges

  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width  - pad * 2)
    const y = pad + (1 - (v - min) / range)  * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  // Fill area under the line
  const first = pts.split(' ')[0]
  const last  = pts.split(' ').at(-1)
  const [lastX] = last.split(',')
  const [firstX] = first.split(',')
  const fillPts = `${firstX},${height} ${pts} ${lastX},${height}`

  const strokeColor = color || 'rgb(var(--brand-500))'
  const fillColor   = color
    ? `${color}22`
    : 'rgba(var(--brand-500) / 0.12)'

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block overflow-visible"
      aria-hidden="true"
    >
      <polygon points={fillPts} fill={fillColor} />
      <polyline
        points={pts}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
