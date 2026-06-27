'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

function generateInviteCode(length = 8): string {
  // Omit visually ambiguous chars (0, O, I, 1)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(
    { length },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('')
}

export async function createRoom(formData: FormData) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const name = (formData.get('name') as string).trim()
  if (!name) redirect('/rooms/create?error=Room+name+is+required')

  const invite_code = generateInviteCode()

  // create_room is a SECURITY DEFINER function that inserts room + member
  // atomically, bypassing the RLS chicken-and-egg problem.
  const { data: roomId, error } = await supabase.rpc('create_room', {
    p_name: name,
    p_invite_code: invite_code,
  })

  if (error) {
    redirect(`/rooms/create?error=${encodeURIComponent(error.message)}`)
  }

  redirect(`/rooms/${roomId}`)
}

export async function joinRoom(formData: FormData) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const invite_code = (formData.get('invite_code') as string).trim().toUpperCase()
  if (!invite_code) redirect('/rooms/join?error=Invite+code+is+required')

  const { data: roomId, error } = await supabase.rpc('join_room_by_invite_code', {
    p_invite_code: invite_code,
  })

  if (error) {
    const msg = error.message.includes('Room not found')
      ? 'Room not found — check the invite code and try again.'
      : error.message
    redirect(`/rooms/join?error=${encodeURIComponent(msg)}`)
  }

  redirect(`/rooms/${roomId}`)
}
