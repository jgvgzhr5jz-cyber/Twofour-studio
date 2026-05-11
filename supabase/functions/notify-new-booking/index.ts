import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const ADMIN_LINE_ID = Deno.env.get('ADMIN_LINE_ID') ?? ''

serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })

  const { student_name, phone, instrument, package: pkg, day_time } = await req.json()

  if (!ADMIN_LINE_ID) return new Response('no admin id', { status: 200 })

  const text = [
    '🔔 มีการจองใหม่! (จากเว็บ)',
    `👤 ${student_name || '—'}`,
    phone ? `📞 ${phone}` : '',
    `🎸 ${instrument} · ${pkg}`,
    `📅 ${day_time}`,
    '',
    '👉 ยืนยันได้ที่: https://twofour-studio.vercel.app/?admin',
  ].filter(Boolean).join('\n')

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: ADMIN_LINE_ID, messages: [{ type: 'text', text }] }),
  })

  const result = await res.json()
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
})
