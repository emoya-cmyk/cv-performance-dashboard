import { useState, useEffect } from 'react'
import { USE_API, api } from '@/lib/api'

// ── Memory OS — read-only "Performance Memory" panel ──────────────────────────
//
// Surfaces a client's durable 'highlight' memories: the deterministic weekly
// movements the intelligence layer has remembered (api/lib/memoryProducer.js),
// recalled scoped + decay-ranked through GET /api/memory/:clientId.
//
// Leak-safe by construction:
//   • requests ONLY the client-safe 'highlight' kind (never agency-internal
//     notes a client shouldn't read), and
//   • the endpoint hard-pins a client token to its own tenant server-side, so a
//     client can only ever see its own memories.
// Self-hides when there's nothing remembered yet, so a fresh account has no
// empty box. Read-only — writing/forgetting is an agency/system concern.
export default function MemoryPanel({ clientId }) {
  const [memories, setMemories] = useState([])

  useEffect(() => {
    if (!USE_API || !clientId) return
    let live = true
    api.getClientMemory(clientId, { kind: 'highlight', k: 6 })
      .then((r) => { if (live) setMemories(Array.isArray(r?.memories) ? r.memories : []) })
      .catch(() => {})
    return () => { live = false }
  }, [clientId])

  if (!USE_API || memories.length === 0) return null

  return (
    <div className="no-print bg-white rounded-2xl border border-slate-100 shadow-sm px-5 py-4">
      <h3 className="text-[11px] font-black uppercase tracking-widest text-slate-500 mb-3">
        Performance Memory
      </h3>
      <div className="space-y-2.5">
        {memories.map((m) => (
          <div key={m.id} className="flex items-start gap-2.5">
            <span className="mt-0.5 shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700">
              Noted
            </span>
            <div className="min-w-0">
              <p className="text-xs text-slate-700 leading-snug">{m.content}</p>
              {m.updated_at && (
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {new Date(m.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
