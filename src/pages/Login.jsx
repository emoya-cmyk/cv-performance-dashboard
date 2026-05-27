import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TrendingUp, Eye, EyeOff } from 'lucide-react'
import { setToken } from '@/lib/auth'

export default function Login() {
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPw,   setShowPw]   = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    // Read directly from DOM so autofill values are captured even if
    // React onChange didn't fire (common with password managers)
    const formEmail    = e.target.elements['email']?.value    || email
    const formPassword = e.target.elements['password']?.value || password
    try {
      const r = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: formEmail, password: formPassword }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Login failed')
      setToken(data.token)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0a0a0a' }}>
      <div className="w-full max-w-sm">

        {/* Brand mark */}
        <div className="flex items-center justify-center gap-3 mb-10">
          <div className="w-11 h-11 rounded-2xl bg-brand-500 flex items-center justify-center shadow-lg shadow-brand-500/30">
            <TrendingUp className="w-5 h-5 text-white" />
          </div>
          <div className="leading-tight">
            <p className="text-[11px] font-black tracking-[0.2em] text-brand-500 uppercase">10X Performance</p>
            <p className="text-[10px] text-slate-500 tracking-wide">Marketing Dashboard</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
          {/* Red top accent */}
          <div className="h-1 bg-brand-500" />

          <div className="p-8">
            <h1 className="text-xl font-black text-slate-900 mb-1">Sign in</h1>
            <p className="text-xs text-slate-400 mb-7">Enter your credentials to access the dashboard</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Email address
                </label>
                <input
                  type="email"
                  name="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all placeholder-slate-300"
                  placeholder="you@agency.com"
                  required
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    name="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-4 py-2.5 pr-10 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-all placeholder-slate-300"
                    placeholder="••••••••"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(p => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="bg-brand-50 border border-brand-100 rounded-xl px-4 py-2.5">
                  <p className="text-xs text-brand-500 font-semibold">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-brand-500 hover:bg-brand-600 active:bg-brand-700 text-white font-black text-sm py-3 rounded-xl transition-colors disabled:opacity-50 shadow-lg shadow-brand-500/25 mt-2"
              >
                {loading ? 'Signing in…' : 'Sign In →'}
              </button>
            </form>
          </div>
        </div>

        <p className="text-center text-[11px] text-slate-600 mt-6">
          First time?{' '}
          <code className="text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded text-[10px]">
            POST /api/auth/setup
          </code>{' '}
          to create your account.
        </p>
      </div>
    </div>
  )
}
