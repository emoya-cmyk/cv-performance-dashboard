import { useState, useCallback } from 'react'
import { Responsive, WidthProvider } from 'react-grid-layout/legacy'
import { GripVertical, LayoutGrid, Lock } from 'lucide-react'
import 'react-grid-layout/css/styles.css'

const ResponsiveGridLayout = WidthProvider(Responsive)

/**
 * WidgetGrid — drag-and-drop responsive grid container.
 *
 * Props:
 *   layoutKey      — string key used for localStorage persistence
 *   defaultLayout  — array of react-grid-layout layout items: { i, x, y, w, h, minW?, minH? }
 *   children       — each child must have a `key` matching a layout item `i`
 *   cols           — optional cols override (default: { lg:12, md:10, sm:6, xs:4, xxs:2 })
 *   rowHeight      — optional row height in px (default: 80)
 */
export default function WidgetGrid({
  layoutKey,
  defaultLayout,
  children,
  cols = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 },
  rowHeight = 80,
}) {
  const storageKey = `dashboard_layout_${layoutKey}`

  const [editing, setEditing] = useState(false)

  // Load saved layout from localStorage, fall back to defaultLayout
  const [layouts, setLayouts] = useState(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) return JSON.parse(saved)
    } catch (_) {}
    return { lg: defaultLayout }
  })

  const handleLayoutChange = useCallback((currentLayout, allLayouts) => {
    setLayouts(allLayouts)
    try {
      localStorage.setItem(storageKey, JSON.stringify(allLayouts))
    } catch (_) {}
  }, [storageKey])

  const resetLayout = () => {
    const fresh = { lg: defaultLayout }
    setLayouts(fresh)
    try {
      localStorage.removeItem(storageKey)
    } catch (_) {}
  }

  return (
    <div className="relative">
      {/* Edit Layout toggle */}
      <div className="flex items-center justify-end gap-2 mb-3">
        {editing && (
          <button
            onClick={resetLayout}
            className="text-[11px] font-bold text-slate-400 hover:text-slate-600 transition-colors px-2 py-1 rounded-lg hover:bg-slate-100"
          >
            Reset layout
          </button>
        )}
        <button
          onClick={() => setEditing(e => !e)}
          className={`flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-xl transition-all border ${
            editing
              ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
              : 'text-slate-500 border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          {editing ? <LayoutGrid className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
          {editing ? 'Done editing' : 'Edit layout'}
        </button>
      </div>

      <ResponsiveGridLayout
        className="layout"
        layouts={layouts}
        cols={cols}
        rowHeight={rowHeight}
        margin={[16, 16]}
        containerPadding={[0, 0]}
        onLayoutChange={handleLayoutChange}
        isDraggable={editing}
        isResizable={editing}
        draggableHandle=".widget-drag-handle"
        useCSSTransforms
      >
        {children && (Array.isArray(children) ? children : [children]).map(child => {
          if (!child) return null
          return (
            <div
              key={child.key}
              className={`relative group ${editing ? 'ring-2 ring-dashed ring-brand-300 rounded-2xl' : ''}`}
              style={{ height: '100%' }}
            >
              {/* Grip handle — only visible in editing mode */}
              {editing && (
                <div className="widget-drag-handle absolute top-3 right-3 z-10 cursor-grab active:cursor-grabbing p-1 rounded-lg bg-white/90 backdrop-blur-sm shadow-sm border border-slate-200 hover:bg-slate-50 transition-colors">
                  <GripVertical className="w-3.5 h-3.5 text-slate-400" />
                </div>
              )}
              <div style={{ height: '100%' }}>
                {child}
              </div>
            </div>
          )
        })}
      </ResponsiveGridLayout>
    </div>
  )
}
