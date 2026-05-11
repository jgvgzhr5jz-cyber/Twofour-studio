import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN  = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const CHANNEL_SECRET = Deno.env.get('LINE_CHANNEL_SECRET') ?? ''
const SUPABASE_URL   = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ADMIN_LINE_ID  = Deno.env.get('ADMIN_LINE_ID') ?? ''

// ─── LINE Signature Verification ────────────────────────────────────────────
async function verifyLineSignature(rawBody: string, signature: string): Promise<boolean> {
  if (!CHANNEL_SECRET) return true
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(CHANNEL_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
    const expected = btoa(String.fromCharCode(...new Uint8Array(mac)))
    return expected === signature
  } catch {
    return false
  }
}

// ─── Schedule config (used for makeup slot selection) ───────────────────────
const WEEKDAY_SLOTS = ['16:00 – 17:00', '17:00 – 18:00', '18:00 – 19:00']
const WEEKEND_SLOTS = ['10:00 – 11:00', '11:00 – 12:00', '13:00 – 14:00', '14:00 – 15:00', '15:00 – 16:00']
const ALL_DAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์', 'อาทิตย์']
const WEEKDAYS = new Set(['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์'])

const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟']
function numEmoji(i: number) { return NUM_EMOJI[i] ?? `${i + 1}.` }

// ─── LINE helpers ────────────────────────────────────────────────────────────
async function pushMessage(to: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`pushMessage failed: HTTP ${res.status} body=${body}`)
  }
}

// deno-lint-ignore no-explicit-any
async function replyMessages(replyToken: string, messages: any[]) {
  if (!replyToken) { console.warn('replyMessage: empty replyToken'); return }
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`replyMessage failed: HTTP ${res.status} body=${body}`)
  }
}

async function replyMessage(replyToken: string, text: string) {
  await replyMessages(replyToken, [{ type: 'text', text }])
}

// ─── Package Rich Card (Flex Message) ────────────────────────────────────────
function buildPackageCard(userId: string) {
  const webUrl = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`

  function pkgRow(emoji: string, name: string, detail: string, price: string, color: string) {
    return {
      type: 'box', layout: 'horizontal', paddingTop: '12px', paddingBottom: '12px',
      contents: [
        {
          type: 'box', layout: 'vertical', flex: 1,
          contents: [
            { type: 'text', text: `${emoji} ${name}`, weight: 'bold', size: 'sm', color: '#1a1a1a' },
            { type: 'text', text: detail, size: 'xs', color: '#888888', margin: 'xs' },
          ],
        },
        {
          type: 'text', text: price, weight: 'bold', size: 'sm',
          color, align: 'end', gravity: 'center',
        },
      ],
    }
  }

  function separator() {
    return { type: 'separator', color: '#eeeeee' }
  }

  return {
    type: 'flex',
    altText: 'แพ็กเกจและราคา TWOFOUR Studio',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box', layout: 'vertical',
        paddingAll: '20px',
        backgroundColor: '#C8922A',
        contents: [
          { type: 'text', text: 'TWOFOUR STUDIO', weight: 'bold', size: 'lg', color: '#ffffff' },
          { type: 'text', text: 'แพ็กเกจและราคาเรียน', size: 'sm', color: '#fce8c0', margin: 'xs' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '16px',
        contents: [
          pkgRow('✨', 'ทดลองเรียนฟรี', '20 นาที • พบครูตัวต่อตัว', 'ฟรี!', '#00967d'),
          separator(),
          pkgRow('📗', 'Short Course', '4 ครั้ง • ครั้งละ 1 ชั่วโมง', '฿2,000', '#1a1a1a'),
          separator(),
          pkgRow('⭐', 'Full Course', '12 ครั้ง • ครั้งละ 1 ชั่วโมง', '฿5,500', '#C8922A'),
          separator(),
          pkgRow('🎯', 'Special Skill', '8 ครั้ง • เฉพาะทาง', '฿6,000', '#1a1a1a'),
          {
            type: 'box', layout: 'vertical', margin: 'md',
            contents: [
              { type: 'text', text: '🎸 กีตาร์ • เบส • กลอง • คีย์บอร์ด • ร้องเพลง', size: 'xxs', color: '#aaaaaa', align: 'center' },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '16px', paddingTop: '0px',
        contents: [
          {
            type: 'button', style: 'primary', color: '#C8922A', height: 'sm',
            action: { type: 'uri', label: 'ดูรายละเอียด →', uri: webUrl },
          },
        ],
      },
    },
  }
}

// deno-lint-ignore no-explicit-any
async function resetState(db: any, userId: string) {
  await db.from('line_followers').update({ state: null, state_data: null }).eq('line_user_id', userId)
}

// ─── Available slots for makeup ──────────────────────────────────────────────
interface SlotEntry { day: string; slot: string }

// deno-lint-ignore no-explicit-any
async function getAvailableSlots(db: any): Promise<SlotEntry[]> {
  const allSlots: SlotEntry[] = []
  for (const day of ALL_DAYS) {
    const slots = WEEKDAYS.has(day) ? WEEKDAY_SLOTS : WEEKEND_SLOTS
    for (const slot of slots) allSlots.push({ day, slot })
  }
  const { data: bookings } = await db.from('bookings').select('day_th, time_slot').in('status', ['confirmed', 'pending'])
  const { data: blocked }  = await db.from('blocked_slots').select('day_th, time_slot')
  const taken = new Set<string>()
  for (const b of bookings ?? []) if (b.day_th) taken.add(`${b.day_th}|${b.time_slot}`)
  for (const b of blocked  ?? []) taken.add(`${b.day_th}|${b.time_slot}`)
  return allSlots.filter(s => !taken.has(`${s.day}|${s.slot}`))
}

function buildSlotList(slots: SlotEntry[]): string {
  const grouped: Record<string, string[]> = {}
  for (const { day, slot } of slots) {
    if (!grouped[day]) grouped[day] = []
    grouped[day].push(slot)
  }
  let idx = 0
  const lines: string[] = ['📅 ช่วงว่างที่มี:\n']
  for (const day of ALL_DAYS) {
    if (!grouped[day]) continue
    lines.push(day)
    for (const slot of grouped[day]) { lines.push(`${numEmoji(idx)} ${slot}`); idx++ }
    lines.push('')
  }
  lines.push('พิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
  return lines.join('\n').trim()
}

// ─── Main handler ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })

  const rawBody  = await req.text()
  const signature = req.headers.get('x-line-signature') ?? ''
  if (!(await verifyLineSignature(rawBody, signature))) {
    console.error('Invalid LINE signature — rejected')
    return new Response('Unauthorized', { status: 401 })
  }

  const body = JSON.parse(rawBody)
  const db   = createClient(SUPABASE_URL, SUPABASE_KEY)

  for (const event of body.events || []) {
    const userId     = event.source?.userId
    const replyToken = event.replyToken ?? ''
    if (!userId) continue

    // ── FOLLOW ────────────────────────────────────────────────────────────────
    if (event.type === 'follow') {
      const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
        headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
      })
      const profile  = await profileRes.json()
      const displayName: string = profile.displayName || ''

      await db.from('line_followers').upsert(
        { line_user_id: userId, display_name: displayName },
        { onConflict: 'line_user_id' }
      )

      // Auto-link student record
      const { data: students } = await db.from('students').select('id, name')
      if (students) {
        const matched = students.find((s: { id: string; name: string }) =>
          s.name?.toLowerCase().includes(displayName.toLowerCase()) ||
          displayName.toLowerCase().includes(s.name?.toLowerCase() ?? '')
        )
        if (matched) await db.from('students').update({ line_id: userId }).eq('id', matched.id)
      }

      await pushMessage(userId, [
        `สวัสดีครับ ${displayName} 🎵`,
        `ยินดีต้อนรับสู่ TWOFOUR Studio!`,
        ``,
        `บอทนี้จะแจ้งเตือนวันเรียนและรับแจ้งลาอัตโนมัติครับ`,
        ``,
        `📚 สนใจเรียน / สอบถาม / ทดลองเรียน`,
        `→ ทักแชทนี้ได้เลย ครูจะตอบกลับโดยตรงครับ 🙏`,
      ].join('\n'))
      // Send package card via push (follow has no replyToken)
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: userId, messages: [buildPackageCard(userId)] }),
      })
      if (!res.ok) console.error('push packageCard failed:', await res.text())
      continue
    }

    // ── IMAGE (สลิปชำระเงิน) ──────────────────────────────────────────────────
    if (event.type === 'message' && event.message?.type === 'image') {
      const { data: follower } = await db.from('line_followers').select('display_name').eq('line_user_id', userId).single()
      const name = follower?.display_name || userId
      await replyMessage(replyToken, 'ได้รับสลิปแล้วครับ ✅\nครูจะตรวจสอบและยืนยันให้เร็วๆ นี้นะครับ 🙏')
      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          '🧾 มีสลิปชำระเงินใหม่!',
          `👤 ${name}`,
          '',
          '👉 ตรวจสอบและยืนยันได้ที่:',
          'https://twofour-studio.vercel.app/?admin',
        ].join('\n'))
      }
      continue
    }

    // ── TEXT message ──────────────────────────────────────────────────────────
    if (event.type !== 'message' || event.message?.type !== 'text') continue

    const messageText: string = event.message.text?.trim() ?? ''

    // Ensure row exists
    await db.from('line_followers').upsert({ line_user_id: userId }, { onConflict: 'line_user_id', ignoreDuplicates: true })

    // Fetch state
    const { data: follower } = await db
      .from('line_followers')
      .select('state, state_data, display_name, last_menu_at')
      .eq('line_user_id', userId)
      .single()

    let currentState: string | null = follower?.state ?? null
    // deno-lint-ignore no-explicit-any
    let stateData: Record<string, any> = follower?.state_data ?? {}
    const displayName: string = follower?.display_name ?? ''
    const lastMenuAt: string | null = follower?.last_menu_at ?? null

    function sentMenuToday(): boolean {
      if (!lastMenuAt) return false
      const nowTH  = new Date(Date.now() + 7 * 60 * 60 * 1000)
      const sentTH = new Date(new Date(lastMenuAt).getTime() + 7 * 60 * 60 * 1000)
      return nowTH.toISOString().slice(0, 10) === sentTH.toISOString().slice(0, 10)
    }
    async function markMenuSent() {
      await db.from('line_followers').update({ last_menu_at: new Date().toISOString() }).eq('line_user_id', userId)
    }

    // Auto-expire state after 10 minutes
    if (currentState && stateData?.ts) {
      if (Date.now() - stateData.ts > 10 * 60 * 1000) {
        await resetState(db, userId)
        currentState = null; stateData = {}
      }
    }

    // "ยกเลิก" resets state
    if (messageText === 'ยกเลิก') {
      if (currentState) { await resetState(db, userId); await replyMessage(replyToken, '↩️ ยกเลิกแล้วครับ') }
      continue
    }

    // ── State: selecting_class_to_cancel (แจ้งลา) ────────────────────────────
    if (currentState === 'selecting_class_to_cancel') {
      const bookingList: { id: string; instrument: string; day_th: string; time_slot: string }[] = stateData.bookings ?? []
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > bookingList.length) {
        const lines = ['📚 คลาสของคุณ:\n']
        bookingList.forEach((b, i) => lines.push(`${numEmoji(i)} ${b.instrument} · ${b.day_th} ${b.time_slot}`))
        lines.push('\nพิมพ์หมายเลขที่ต้องการลา')
        await replyMessage(replyToken, lines.join('\n'))
        continue
      }
      const chosen = bookingList[num - 1]
      const availableSlots = await getAvailableSlots(db)
      if (availableSlots.length === 0) {
        await db.from('absences').insert({ line_user_id: userId, student_name: displayName, absent_date: chosen.day_th, absent_time: chosen.time_slot, status: 'pending' })
        await resetState(db, userId)
        await replyMessage(replyToken, '✅ บันทึกการลาแล้วครับ\nครูจะแจ้งวันชดเชยให้เร็วๆ นี้ 🙏')
        if (ADMIN_LINE_ID) {
          await pushMessage(ADMIN_LINE_ID, [
            '🔔 มีคำขอลา!', `👤 ${displayName}`, `📅 ${chosen.day_th} ${chosen.time_slot}`, '', 'ไม่มีช่วงว่าง — กรุณาแจ้งวันชดเชยให้นักเรียนเอง',
          ].join('\n'))
        }
      } else {
        const lines = [`📅 ลา: ${chosen.instrument} · ${chosen.day_th} ${chosen.time_slot}\n`, '📅 เลือกวันชดเชย:\n']
        availableSlots.forEach((s, i) => lines.push(`${numEmoji(i)} ${s.day} ${s.slot}`))
        lines.push('\nพิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
        await replyMessage(replyToken, lines.join('\n'))
        await db.from('line_followers').update({
          state: 'selecting_makeup_slot',
          state_data: { ts: Date.now(), booking_id: chosen.id, instrument: chosen.instrument, day_th: chosen.day_th, time_slot: chosen.time_slot, available_slots: availableSlots },
        }).eq('line_user_id', userId)
      }
      continue
    }

    // ── State: selecting_makeup_slot ─────────────────────────────────────────
    if (currentState === 'selecting_makeup_slot') {
      const availableSlots: SlotEntry[] = stateData.available_slots ?? []
      const { day_th, time_slot } = stateData
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > availableSlots.length) {
        const lines = ['📅 เลือกวันชดเชย:\n']
        availableSlots.forEach((s, i) => lines.push(`${numEmoji(i)} ${s.day} ${s.slot}`))
        lines.push('\nพิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
        await replyMessage(replyToken, lines.join('\n'))
        continue
      }
      const makeup = availableSlots[num - 1]
      await db.from('absences').insert({ line_user_id: userId, student_name: displayName, absent_date: day_th, absent_time: time_slot, makeup_date: makeup.day, makeup_time: makeup.slot, status: 'pending' })
      await resetState(db, userId)
      await replyMessage(replyToken, ['✅ บันทึกการลาแล้วครับ', `📅 วันที่ลา: ${day_th} ${time_slot}`, `🔁 วันชดเชยที่ขอ: ${makeup.day} ${makeup.slot}`, '', 'รอครูยืนยันนะครับ 🙏'].join('\n'))
      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, ['🔔 มีคำขอลา!', `👤 ${displayName}`, `📅 ลา: ${day_th} ${time_slot}`, `🔁 ขอชดเชย: ${makeup.day} ${makeup.slot}`, '', 'ไปยืนยันที่ Admin Panel'].join('\n'))
      }
      continue
    }

    // ── No active state — handle commands or redirect ─────────────────────────
    if (messageText === 'แจ้งลา') {
      const { data: bookings } = await db
        .from('bookings').select('id, instrument, day_th, time_slot')
        .eq('line_user_id', userId).in('status', ['confirmed', 'pending'])
        .order('created_at', { ascending: false }).limit(5)

      if (!bookings || bookings.length === 0) {
        await replyMessage(replyToken, 'ไม่พบคลาสที่จองไว้ครับ')
      } else {
        const lines = ['📚 คลาสของคุณ:\n']
        bookings.forEach((b: { id: string; instrument: string; day_th: string; time_slot: string }, i: number) => {
          lines.push(`${numEmoji(i)} ${b.instrument} · ${b.day_th} ${b.time_slot}`)
        })
        lines.push('\nพิมพ์หมายเลขที่ต้องการลา')
        await replyMessage(replyToken, lines.join('\n'))
        await db.from('line_followers').update({
          state: 'selecting_class_to_cancel',
          state_data: { ts: Date.now(), bookings: bookings.map((b: { id: string; instrument: string; day_th: string; time_slot: string }) => ({ id: b.id, instrument: b.instrument, day_th: b.day_th, time_slot: b.time_slot })) },
        }).eq('line_user_id', userId)
      }
      continue
    }

    // ── All other messages → auto-reply with package card (once per day) ───────
    if (!sentMenuToday()) {
      await replyMessages(replyToken, [
        {
          type: 'text',
          text: [
            `ขอบคุณที่ทักมานะครับ ${displayName ? displayName + ' ' : ''}🙏`,
            'ครูจะตอบกลับเร็วๆ นี้ครับ',
            '',
            '📌 หากต้องการแจ้งลา พิมพ์ "แจ้งลา" ได้เลยครับ',
          ].join('\n'),
        },
        buildPackageCard(userId),
      ])
      await markMenuSent()

      // แจ้ง admin เมื่อมีคนทักใหม่ (ครั้งแรกของวัน)
      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          `💬 ${displayName || 'มีคนทักใหม่'}`,
          `"${messageText.length > 60 ? messageText.slice(0, 60) + '…' : messageText}"`,
          '',
          '👉 ตอบกลับได้ใน LINE OA Manager',
        ].join('\n'))
      }
    }
  }

  return new Response('ok', { status: 200 })
})
