const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5001'

// Generate stable userId per browser session
export function getUserId() {
  let id = localStorage.getItem('tatva_uid')
  if (!id) {
    id = 'user_' + Math.random().toString(36).substring(2, 15)
    localStorage.setItem('tatva_uid', id)
  }
  return id
}

export async function saveToMemory(userId, message, response, source) {
  try {
    await fetch(`${BACKEND_URL}/api/memory/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, message, response, sourceLabel: source })
    })
  } catch(e) {
    console.warn('Memory save failed:', e)
  }
}

export async function loadMemory(userId) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/memory/${userId}`)
    const { history } = await res.json()
    return history || []
  } catch {
    return []
  }
}
