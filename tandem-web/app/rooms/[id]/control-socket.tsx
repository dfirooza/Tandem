'use client'

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Browser WebSocket to tandem-server for remote session control (Stage 10).
// One connection per open room tab, established on mount: the server ties
// control grants to the controller's open web connections, so closing the
// tab auto-releases control. Input sent here is re-verified server-side
// against the current controller on every message — this client carries
// keystrokes, it does not confer authority.

interface ControlSocketApi {
  /** Sends controller keystrokes; a no-op while the socket is down. */
  sendInput: (sessionId: string, content: string) => void
  connected: boolean
}

const ControlSocketContext = createContext<ControlSocketApi>({
  sendInput: () => {},
  connected: false,
})

export function useControlSocket(): ControlSocketApi {
  return useContext(ControlSocketContext)
}

export default function ControlSocketProvider({
  roomId,
  userId,
  children,
}: {
  roomId: string
  userId: string
  children: React.ReactNode
}) {
  const wsRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_TANDEM_SERVER_URL
    if (!url) return

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    async function connect() {
      if (disposed) return
      const supabase = createClient()
      const {
        data: { session },
      } = await supabase.auth.getSession()
      if (!session || disposed) return

      socket = new WebSocket(url!)
      wsRef.current = socket

      socket.onopen = () => {
        socket?.send(
          JSON.stringify({
            type: 'auth',
            role: 'web',
            roomId,
            userId,
            token: session.access_token,
          })
        )
      }
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === 'auth_ok') {
            readyRef.current = true
            setConnected(true)
          }
        } catch {
          // ignore malformed frames
        }
      }
      socket.onclose = () => {
        readyRef.current = false
        setConnected(false)
        wsRef.current = null
        if (!disposed) retryTimer = setTimeout(connect, 3000)
      }
      socket.onerror = () => socket?.close()
    }

    void connect()

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      readyRef.current = false
      socket?.close()
      wsRef.current = null
    }
  }, [roomId, userId])

  const api: ControlSocketApi = {
    sendInput: (sessionId, content) => {
      const ws = wsRef.current
      if (ws && readyRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session_input', sessionId, content }))
      }
    },
    connected,
  }

  return (
    <ControlSocketContext.Provider value={api}>
      {children}
    </ControlSocketContext.Provider>
  )
}
