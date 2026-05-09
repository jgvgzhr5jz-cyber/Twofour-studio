import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const DAY_TH = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์']

async function pushMessage(to: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  return res.ok
}

serve(async (req) => {
  const db = createClient(SUPABASE_URL, SUPABASE_KEY)

  // Detect mode from query string or body
  const url = new URL(req.url)
  let mode = url.searchParams.get('mode') ?? 'tomorrow'
  if (req.method === 'POST') {
    try {
      const body = await req.json()
      if (body?.mode) mode = body.mode
    } catch { /* ignore */ }
  }

  // Bangkok time (UTC+7)
  const now = new Date()
  const bangkokNow = new Date(now.getTime() + 7 * 60 * 60 * 1000)
  const todayDow    = bangkokNow.getUTCDay()
  const tomorrowDow = (todayDow + 1) % 7

  const targetDow = mode === 'today' ? todayDow : tomorrowDow
  const targetDay = DAY_TH[targetDow]

  // Fetch confirmed bookings for target day
  const { data: bookings, error } = await db
    .from('bookings')
    .select('id, student_name, instrument, package, day_th, time_slot, line_user_id')
    .eq('day_th', targetDay)
    .eq('status', 'confirmed')
    .not('line_user_id', 'is', null)

  if (error) {
    console.error('DB error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  if (!bookings || bookings.length === 0) {
    return new Response(
      JSON.stringify({ message: `ไม่มีคลาสวัน${targetDay}`, sent: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  }

  let sent = 0
  for (const b of bookings) {
    const text = mode === 'today'
      ? [
          '🌅 วันนี้มีเรียนนะครับ!',
          `👤 ${b.student_name}`,
          `🎸 ${b.instrument} · ${b.package}`,
          `📅 ${b.day_th} ${b.time_slot}`,
          '',
          'พบกันวันนี้ครับ 🎵',
        ].join('\n')
      : [
          '⏰ เตือนความจำ — พรุ่งนี้มีเรียน!',
          `👤 ${b.student_name}`,
          `🎸 ${b.instrument} · ${b.package}`,
          `📅 ${b.day_th} ${b.time_slot}`,
          '',
          'พบกันพรุ่งนี้นะครับ 🎵',
        ].join('\n')

    const ok = await pushMessage(b.line_user_id, text)
    if (ok) sent++
  }

  return new Response(
    JSON.stringify({ message: `ส่งการแจ้งเตือนวัน${targetDay}`, mode, total: bookings.length, sent }),
    { headers: { 'Content-Type': 'application/json' } }
  )
})
