import { Navigate, useLocation } from 'react-router-dom'
import { isLoggedIn } from '@/lib/auth'
import { USE_API } from '@/lib/api'

// In mock mode (no API URL) auth is bypassed entirely
export default function RequireAuth({ children }) {
  const location = useLocation()
  if (USE_API && !isLoggedIn()) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  return children
}
