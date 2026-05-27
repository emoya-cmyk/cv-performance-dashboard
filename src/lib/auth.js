const TOKEN_KEY = 'pd_token'
const USER_KEY  = 'pd_user'

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function setUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}

export function isLoggedIn() {
  return Boolean(getToken())
}

/** Returns true if the logged-in user has role 'agency' or 'admin' */
export function isAgency() {
  const user = getUser()
  return user?.role === 'agency' || user?.role === 'admin'
}
