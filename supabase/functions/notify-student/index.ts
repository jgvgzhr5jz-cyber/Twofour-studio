import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN  = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ADMIN_LINE_ID  = Deno.env.get('ADMIN_LINE_ID') ?? ''

serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })

  const { record, old_record } = await req.json()
  if (!record) return new Response('no record', { status: 400 })

  const db = createClient(SUPABASE_URL, SUPABASE_KEY)

  const isInsert    = !old_record
  const isConfirmed = record.status === 'confirmed' && old_record?.status !== 'confirmed'

  // Skip events we don't care about early
  if (!isInsert && !isConfirmed) return new Response('skip', { status: 200 })

  const push = async (to: string, msg: string) => {
    if (!to) return
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: msg }] })
    })
  }

  const dayTime = record.day_th ? `${record.day_th} ${record.time_slot}` : (record.time_slot || '—')

  // ── Admin notification (always on INSERT) ─────────────────────────────────
  if (isInsert && ADMIN_LINE_ID) {
    await push(ADMIN_LINE_ID, [
      '🔔 มีการจองใหม่!',
      `👤 ${record.student_name}`,
      `🎸 ${record.instrument} · ${record.package}`,
      `📅 ${dayTime}`,
      '',
      '👉 ยืนยันได้ที่:',
      'https://twofour-studio.vercel.app/?admin',
    ].join('\n'))
  }

  // ── Find student LINE ID ───────────────────────────────────────────────────
  // Priority: 1) record.line_user_id  2) student_id→students.line_id  3) name match
  let lineUserId: string | null = null

  if (record.line_user_id) {
    lineUserId = record.line_user_id
  }

  if (!lineUserId && record.student_id) {
    const { data: student } = await db
      .from('students')
      .select('line_id')
      .eq('id', record.student_id)
      .single()
    if (student?.line_id) lineUserId = student.line_id
  }

  if (!lineUserId && record.student_name) {
    const name = record.student_name.trim()
    const { data: followers } = await db
      .from('line_followers')
      .select('line_user_id, display_name')
    if (followers) {
      const match = followers.find(f =>
        f.display_name?.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(f.display_name?.toLowerCase() ?? '')
      )
      if (match) lineUserId = match.line_user_id
    }
  }

  // ── Student notification ───────────────────────────────────────────────────
  if (!lineUserId) return new Response('no student line id', { status: 200 })

  const isTrial = record.package?.includes('ทดลอง')

  let text = ''
  if (isInsert) {
    const lines = [
      '📋 ได้รับคำขอจองแล้วครับ',
      `👤 ${record.student_name}`,
      `🎸 ${record.instrument} · ${record.package}`,
      `📅 ${dayTime}`,
      '',
      '⚠️ ยังไม่ได้รับการยืนยัน — รบกวนทักทายกลับมาสักคำเพื่อให้ครูทราบนะครับ 🙏',
    ]
    text = lines.join('\n')
  } else if (isConfirmed) {
    text = [
      '✅ ยืนยันการจองแล้ว!',
      `👤 ${record.student_name}`,
      `🎸 ${record.instrument} · ${record.package}`,
      `📅 ${dayTime}`,
      '',
      'ครูรอพบคุณนะครับ 🎵',
    ].join('\n')
  }

  await push(lineUserId, text)

  return new Response('ok', { headers: { 'Content-Type': 'application/json' } })
})
