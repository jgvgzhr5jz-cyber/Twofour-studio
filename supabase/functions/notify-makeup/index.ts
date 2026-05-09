import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''

serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })

  // Require Authorization header
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { line_user_id, student_name, makeup_date, makeup_time } = await req.json()
  if (!line_user_id) return new Response('no line_user_id', { status: 400 })

  const text = [
    '📅 ยืนยันวันชดเชยแล้ว!',
    `👤 ${student_name}`,
    `📆 วันชดเชย: ${makeup_date}`,
    `⏰ เวลา: ${makeup_time}`,
    '',
    'ครูรอพบคุณนะครับ 🎵',
  ].join('\n')

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: line_user_id, messages: [{ type: 'text', text }] })
  })

  const result = await res.json()
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } })
})
