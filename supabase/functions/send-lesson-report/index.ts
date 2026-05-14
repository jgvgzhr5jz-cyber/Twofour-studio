import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const SITE_URL      = 'https://twofour-studio.vercel.app'

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors })

  let body: {
    note_id: string
    student_line_id: string
    student_name: string
    teacher_name: string
    tags: string[]
    note_text?: string
    photo_url?: string
    lesson_date: string
  }

  try { body = await req.json() }
  catch { return new Response('bad json', { status: 400, headers: cors }) }

  const { note_id, student_line_id, student_name, teacher_name, tags, note_text, photo_url, lesson_date } = body

  const db = createClient(SUPABASE_URL, SUPABASE_KEY)

  // ── Build LINE message ────────────────────────────────────────
  const tagLine = tags?.length ? tags.join('  ') : '—'

  const lines: string[] = [
    '📚 รายงานผลการเรียน',
    '─────────────────────',
    `👤 นักเรียน: ${student_name}`,
    `📅 วันที่: ${lesson_date}`,
    `👨‍🏫 ครู: ${teacher_name}`,
    '',
    '📌 สรุปบทเรียน:',
    tagLine,
  ]

  if (note_text) {
    lines.push('', `📝 ${note_text}`)
  }

  if (photo_url) {
    lines.push('', `🖼️ ดูรูปบทเรียน:`, photo_url)
  }

  lines.push('', '─────────────────────', 'Twofour Studio 🎸')

  const message = lines.join('\n')

  // ── Send to student LINE ──────────────────────────────────────
  let lineSent = false
  if (student_line_id && CHANNEL_TOKEN) {
    const pushRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CHANNEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: student_line_id,
        messages: [{ type: 'text', text: message }],
      }),
    })
    lineSent = pushRes.ok
    if (!pushRes.ok) {
      const err = await pushRes.text()
      console.error('LINE push failed:', err)
    }
  }

  // ── Update lesson_note status ─────────────────────────────────
  if (note_id) {
    await db.from('lesson_notes').update({
      status:  lineSent ? 'sent' : 'draft',
      sent_at: lineSent ? new Date().toISOString() : null,
    }).eq('id', note_id)
  }

  if (!lineSent) {
    const reason = !student_line_id ? 'no_line_id' : !CHANNEL_TOKEN ? 'no_token' : 'line_api_error'
    return new Response(
      JSON.stringify({ ok: false, reason }),
      { status: 422, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
  )
})
