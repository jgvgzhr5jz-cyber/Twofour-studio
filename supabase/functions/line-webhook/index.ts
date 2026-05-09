import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ADMIN_LINE_ID = Deno.env.get('ADMIN_LINE_ID') ?? ''

// ─── Schedule config ────────────────────────────────────────────────────────
const WEEKDAY_SLOTS = ['16:00 – 17:00', '17:00 – 18:00', '18:00 – 19:00']
const WEEKEND_SLOTS = ['10:00 – 11:00', '11:00 – 12:00', '13:00 – 14:00', '14:00 – 15:00', '15:00 – 16:00']
const ALL_DAYS = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์', 'เสาร์', 'อาทิตย์']
const WEEKDAYS = new Set(['จันทร์', 'อังคาร', 'พุธ', 'พฤหัส', 'ศุกร์'])

// ─── Instruments & Packages ─────────────────────────────────────────────────
const INSTRUMENTS = ['กีตาร์', 'เบส', 'กลอง', 'คีย์บอร์ด', 'เปียโน', 'ร้องเพลง']
const PACKAGES    = ['ทดลองเรียนฟรี (20 นาที)', 'Short Course (฿2,000 / 4 ครั้ง)', 'Full Course (฿5,500 / 12 ครั้ง)']

// ─── Emoji number helpers ────────────────────────────────────────────────────
const NUM_EMOJI = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟']
function numEmoji(i: number) { return NUM_EMOJI[i] ?? `${i + 1}.` }

// ─── Helper: push LINE message (uses quota — admin/proactive only) ───────────
async function pushMessage(to: string, text: string) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`pushMessage failed: HTTP ${res.status} to=${to} body=${body}`)
  }
}

// ─── Helper: reply LINE message (FREE — use for all chat responses) ──────────
async function replyMessage(replyToken: string, text: string) {
  if (!replyToken) {
    console.warn('replyMessage called with empty replyToken')
    return
  }
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`replyMessage failed: HTTP ${res.status} body=${body}`)
  }
}

// ─── Helper: reset state ────────────────────────────────────────────────────
// deno-lint-ignore no-explicit-any
async function resetState(db: any, userId: string) {
  await db.from('line_followers')
    .update({ state: null, state_data: null })
    .eq('line_user_id', userId)
}

// ─── Helper: get available slots ────────────────────────────────────────────
interface SlotEntry { day: string; slot: string }

// deno-lint-ignore no-explicit-any
async function getAvailableSlots(db: any): Promise<SlotEntry[]> {
  // Build full set of all possible slots
  const allSlots: SlotEntry[] = []
  for (const day of ALL_DAYS) {
    const slots = WEEKDAYS.has(day) ? WEEKDAY_SLOTS : WEEKEND_SLOTS
    for (const slot of slots) {
      allSlots.push({ day, slot })
    }
  }

  // Fetch taken bookings (confirmed or pending)
  const { data: bookings } = await db
    .from('bookings')
    .select('day_th, time_slot')
    .in('status', ['confirmed', 'pending'])

  // Fetch blocked slots
  const { data: blocked } = await db
    .from('blocked_slots')
    .select('day_th, time_slot')

  const takenSet = new Set<string>()
  for (const b of bookings ?? []) {
    takenSet.add(`${b.day_th}|${b.time_slot}`)
  }
  for (const b of blocked ?? []) {
    takenSet.add(`${b.day_th}|${b.time_slot}`)
  }

  return allSlots.filter(s => !takenSet.has(`${s.day}|${s.slot}`))
}

// ─── Message builders ────────────────────────────────────────────────────────
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
    for (const slot of grouped[day]) {
      lines.push(`${numEmoji(idx)} ${slot}`)
      idx++
    }
    lines.push('')
  }
  lines.push('พิมพ์หมายเลขเพื่อจอง หรือพิมพ์ "ยกเลิก" เพื่อออก')
  return lines.join('\n').trim()
}

function buildInstrumentList(): string {
  const lines = ['🎸 เลือกเครื่องดนตรี:\n']
  INSTRUMENTS.forEach((inst, i) => lines.push(`${numEmoji(i)} ${inst}`))
  return lines.join('\n')
}

function buildPackageList(): string {
  const lines = ['📦 เลือกแพ็กเกจ:\n']
  PACKAGES.forEach((pkg, i) => lines.push(`${numEmoji(i)} ${pkg}`))
  return lines.join('\n')
}

// ─── Main handler ────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok', { status: 200 })

  const body = await req.json()
  const db   = createClient(SUPABASE_URL, SUPABASE_KEY)

  for (const event of body.events || []) {
    const userId     = event.source?.userId
    const replyToken = event.replyToken ?? ''
    if (!userId) continue

    // ── FOLLOW event ──────────────────────────────────────────────────────────
    if (event.type === 'follow') {
      const profileRes = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
        headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
      })
      const profile = await profileRes.json()
      const displayName: string = profile.displayName || ''

      await db.from('line_followers').upsert(
        { line_user_id: userId, display_name: displayName },
        { onConflict: 'line_user_id' }
      )

      // Auto-link to existing student record
      const { data: students } = await db.from('students').select('id, name')
      if (students) {
        const matched = students.find((s: { id: string; name: string }) =>
          s.name?.toLowerCase().includes(displayName.toLowerCase()) ||
          displayName.toLowerCase().includes(s.name?.toLowerCase() ?? '')
        )
        if (matched) {
          await db.from('students').update({ line_id: userId }).eq('id', matched.id)
        }
      }

      const bookingLink = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`
      // Follow event has no replyToken → must use push
      await pushMessage(userId, [
        `สวัสดีครับ ${displayName} 🎵`,
        `ขอบคุณที่เพิ่ม TWOFOUR Studio นะครับ ยินดีต้อนรับ!`,
        ``,
        `ที่นี่สอนกีตาร์ เบส กลอง คีย์บอร์ด เปียโน และร้องเพลง`,
        `ทุกระดับตั้งแต่มือใหม่จนถึงมืออาชีพครับ 🙌`,
        ``,
        `กดลิงก์นี้เพื่อดูตารางและจองคลาสได้เลย:`,
        bookingLink,
        ``,
        `หรือพิมพ์ "จองคลาส" เพื่อจองผ่านแชทครับ`,
      ].join('\n'))
      continue
    }

    // ── IMAGE message (สลิปชำระเงิน) ─────────────────────────────────────────
    if (event.type === 'message' && event.message?.type === 'image') {
      const { data: follower } = await db
        .from('line_followers')
        .select('display_name')
        .eq('line_user_id', userId)
        .single()
      const name = follower?.display_name || userId

      await replyMessage(replyToken, 'ได้รับสลิปแล้วครับ ✅\nครูจะตรวจสอบและยืนยันการจองให้เร็วๆ นี้นะครับ 🙏')

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

    // ── MESSAGE event ─────────────────────────────────────────────────────────
    if (event.type !== 'message' || event.message?.type !== 'text') continue

    const messageText: string = event.message.text?.trim() ?? ''

    // Ensure row exists
    await db.from('line_followers').upsert(
      { line_user_id: userId },
      { onConflict: 'line_user_id', ignoreDuplicates: true }
    )

    // Fetch current state
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

    // Helper: check if last_menu_at was already today (Thai time UTC+7)
    function sentMenuToday(): boolean {
      if (!lastMenuAt) return false
      const nowTH  = new Date(Date.now() + 7 * 60 * 60 * 1000)
      const sentTH = new Date(new Date(lastMenuAt).getTime() + 7 * 60 * 60 * 1000)
      return nowTH.toISOString().slice(0, 10) === sentTH.toISOString().slice(0, 10)
    }
    async function markMenuSent() {
      await db.from('line_followers')
        .update({ last_menu_at: new Date().toISOString() })
        .eq('line_user_id', userId)
    }

    // Auto-expire state after 10 minutes
    if (currentState && stateData?.ts) {
      const age = Date.now() - stateData.ts
      if (age > 10 * 60 * 1000) {
        await resetState(db, userId)
        currentState = null
        stateData = {}
      }
    }

    // "ยกเลิก" always resets
    if (messageText === 'ยกเลิก') {
      if (currentState) {
        await resetState(db, userId)
        await replyMessage(replyToken, '↩️ ยกเลิกแล้วครับ')
      }
      continue
    }

    // Navigation commands always reset state and run fresh
    const NAV_COMMANDS = ['ดูตาราง', 'จองคลาส', 'จอง', 'แจ้งลา', 'สนใจ', 'สนใจเรียน', 'อยากเรียน', 'สอบถาม']
    if (currentState && NAV_COMMANDS.includes(messageText)) {
      await resetState(db, userId)
      currentState = null
      stateData = {}
    }

    // ── No active state ───────────────────────────────────────────────────────
    if (!currentState) {
      if (messageText === 'ดูตาราง' || messageText === 'จองคลาส' || messageText === 'จอง') {
        await replyMessage(replyToken, buildInstrumentList())
        await db.from('line_followers')
          .update({ state: 'selecting_instrument', state_data: { ts: Date.now() } })
          .eq('line_user_id', userId)

      } else if (messageText === 'สนใจ' || messageText === 'สนใจเรียน' || messageText === 'อยากเรียน' || messageText === 'สอบถาม') {
        if (!sentMenuToday()) {
          const bookingLink = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`
          await replyMessage(replyToken, [
            `สวัสดีครับ ${displayName ? displayName + ' ' : ''}ยินดีต้อนรับสู่ TWOFOUR Studio 🎵`,
            '',
            '🔗 กดลิงก์นี้เพื่อดูตารางและจองคลาส:',
            bookingLink,
            '',
            'ระบบจะจำ LINE ของคุณอัตโนมัติครับ — จองเสร็จแล้วจะได้รับการยืนยันทาง LINE เลย 🙏',
          ].join('\n'))
          await markMenuSent()
        }

      } else if (messageText === 'แจ้งลา') {
        const { data: bookings } = await db
          .from('bookings')
          .select('id, instrument, day_th, time_slot')
          .eq('line_user_id', userId)
          .in('status', ['confirmed', 'pending'])
          .order('created_at', { ascending: false })
          .limit(5)

        if (!bookings || bookings.length === 0) {
          await replyMessage(replyToken, 'ไม่พบคลาสที่จองไว้ครับ')
        } else {
          const lines = ['📚 คลาสของคุณ:\n']
          bookings.forEach((b: { id: string; instrument: string; day_th: string; time_slot: string }, i: number) => {
            lines.push(`${numEmoji(i)} ${b.instrument} · ${b.day_th} ${b.time_slot}`)
          })
          lines.push('\nพิมพ์หมายเลขที่ต้องการลา')
          await replyMessage(replyToken, lines.join('\n'))
          await db.from('line_followers')
            .update({
              state: 'selecting_class_to_cancel',
              state_data: {
                ts: Date.now(),
                bookings: bookings.map((b: { id: string; instrument: string; day_th: string; time_slot: string }) => ({
                  id: b.id,
                  instrument: b.instrument,
                  day_th: b.day_th,
                  time_slot: b.time_slot,
                })),
              },
            })
            .eq('line_user_id', userId)
        }

      } else {
        // Check if user has a pending/trial booking waiting for confirmation
        const { data: pendingBookings } = await db
          .from('bookings')
          .select('id, instrument, package, day_th, time_slot')
          .eq('line_user_id', userId)
          .in('status', ['pending', 'trial'])
          .order('created_at', { ascending: false })
          .limit(1)

        if (pendingBookings && pendingBookings.length > 0) {
          const b = pendingBookings[0]
          await replyMessage(replyToken, [
            `ขอบคุณที่ทักมานะครับ ${displayName ? displayName + ' ' : ''}🙏`,
            '',
            `📋 คำขอจองของคุณ:`,
            `🎸 ${b.instrument} · ${b.package}`,
            `📅 ${b.day_th} ${b.time_slot}`,
            '',
            'รบกวนแจ้งชื่อ-นามสกุล และเบอร์โทรศัพท์ในข้อความเดียวได้เลยครับ',
            'ตัวอย่าง: สมชาย ใจดี 081-234-5678',
          ].join('\n'))
          await db.from('line_followers')
            .update({
              state: 'awaiting_confirm_info',
              state_data: { ts: Date.now(), booking_id: b.id, instrument: b.instrument, package: b.package, day_th: b.day_th, time_slot: b.time_slot },
            })
            .eq('line_user_id', userId)
        } else {
          // No pending booking — send link + menu (max once per day)
          if (!sentMenuToday()) {
            const bookingLink = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`
            await replyMessage(replyToken, [
              `สวัสดีครับ ${displayName ? displayName + ' ' : ''}👋`,
              '',
              '🔗 กดลิงก์นี้เพื่อดูตารางและจองคลาส:',
              bookingLink,
              '',
              'หรือพิมพ์คำสั่งด้านล่าง:',
              '📅 "จองคลาส" — ดูช่วงว่างและจองผ่านแชท',
              '🙏 "แจ้งลา" — แจ้งขาดเรียน',
            ].join('\n'))
            await markMenuSent()
          }
        }
      }
      continue
    }

    // ── State: selecting_instrument ───────────────────────────────────────────
    if (currentState === 'selecting_instrument') {
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > INSTRUMENTS.length) {
        await replyMessage(replyToken, buildInstrumentList())
        continue
      }
      const instrument = INSTRUMENTS[num - 1]
      await replyMessage(replyToken, buildPackageList())
      await db.from('line_followers')
        .update({
          state: 'selecting_package',
          state_data: { ts: Date.now(), slot_day: stateData.slot_day, slot_time: stateData.slot_time, instrument },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: selecting_package ──────────────────────────────────────────────
    if (currentState === 'selecting_package') {
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > PACKAGES.length) {
        await replyMessage(replyToken, buildPackageList())
        continue
      }
      const pkg = PACKAGES[num - 1]
      await replyMessage(replyToken, '📅 วันและเวลาที่คุณสะดวกเรียนครับ?\nเช่น เสาร์ บ่ายสองโมง หรือ อาทิตย์ 10:00–11:00')
      await db.from('line_followers')
        .update({
          state: 'entering_preferred_time',
          state_data: {
            ts: Date.now(),
            instrument: stateData.instrument,
            package: pkg,
          },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: entering_preferred_time ────────────────────────────────────────
    if (currentState === 'entering_preferred_time') {
      const preferredTime = messageText
      await replyMessage(replyToken, '👤 ชื่อที่ใช้ติดต่อของคุณคืออะไรครับ?')
      await db.from('line_followers')
        .update({
          state: 'entering_name',
          state_data: { ...stateData, ts: Date.now(), preferred_time: preferredTime },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: entering_name ──────────────────────────────────────────────────
    if (currentState === 'entering_name') {
      const name = messageText
      await replyMessage(replyToken, '📞 เบอร์โทรศัพท์ของคุณครับ?')
      await db.from('line_followers')
        .update({
          state: 'entering_phone',
          state_data: { ...stateData, ts: Date.now(), student_name: name },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: entering_phone ─────────────────────────────────────────────────
    if (currentState === 'entering_phone') {
      const { preferred_time, instrument, package: pkg, student_name: name } = stateData
      const phone = messageText
      const status = pkg === 'ทดลองเรียนฟรี (20 นาที)' ? 'trial' : 'pending'

      await db.from('bookings').insert({
        instrument,
        package: pkg,
        day_th: null,
        time_slot: preferred_time,
        status,
        student_name: name,
        phone,
        line_user_id: userId,
      })

      await resetState(db, userId)

      await replyMessage(replyToken, [
        '✅ จองเรียบร้อยแล้ว!',
        `👤 ${name}`,
        `📞 ${phone}`,
        `🎸 ${instrument} · ${pkg}`,
        `📅 ${preferred_time}`,
        '',
        'รอครูยืนยันภายใน 24 ชม. นะครับ 🙏',
      ].join('\n'))

      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          '🔔 มีการจองใหม่! (จากไลน์)',
          `👤 ${name}`,
          `📞 ${phone}`,
          `🎸 ${instrument} · ${pkg}`,
          `📅 ${slot_day} ${slot_time}`,
        ].join('\n'))
      }
      continue
    }

    // ── State: selecting_class_to_cancel ──────────────────────────────────────
    if (currentState === 'selecting_class_to_cancel') {
      const bookingList: { id: string; instrument: string; day_th: string; time_slot: string }[] =
        stateData.bookings ?? []
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > bookingList.length) {
        // Re-show class list
        const lines = ['📚 คลาสของคุณ:\n']
        bookingList.forEach((b, i) => {
          lines.push(`${numEmoji(i)} ${b.instrument} · ${b.day_th} ${b.time_slot}`)
        })
        lines.push('\nพิมพ์หมายเลขที่ต้องการลา')
        await replyMessage(replyToken, lines.join('\n'))
        continue
      }

      const chosen = bookingList[num - 1]
      const availableSlots = await getAvailableSlots(db)

      if (availableSlots.length === 0) {
        // No available slots — record absence, admin will choose
        await db.from('absences').insert({
          line_user_id: userId,
          student_name: displayName,
          absent_date: chosen.day_th,
          absent_time: chosen.time_slot,
          status: 'pending',
        })
        await resetState(db, userId)
        await replyMessage(replyToken, '✅ บันทึกการลาแล้วครับ\nครูจะแจ้งวันชดเชยให้เร็วๆ นี้ 🙏')
        if (ADMIN_LINE_ID) {
          await pushMessage(ADMIN_LINE_ID, [
            '🔔 มีคำขอลา!',
            `👤 ${displayName}`,
            `📅 ${chosen.day_th} ${chosen.time_slot}`,
            '',
            'ไม่มีช่วงว่าง — กรุณาแจ้งวันชดเชยให้นักเรียนเอง',
          ].join('\n'))
        }
      } else {
        const lines = [`📅 ลา: ${chosen.instrument} · ${chosen.day_th} ${chosen.time_slot}\n`, '📅 เลือกวันชดเชย:\n']
        availableSlots.forEach((s, i) => {
          lines.push(`${numEmoji(i)} ${s.day} ${s.slot}`)
        })
        lines.push('\nพิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
        await replyMessage(replyToken, lines.join('\n'))
        await db.from('line_followers')
          .update({
            state: 'selecting_makeup_slot',
            state_data: {
              ts: Date.now(),
              booking_id: chosen.id,
              instrument: chosen.instrument,
              day_th: chosen.day_th,
              time_slot: chosen.time_slot,
              available_slots: availableSlots,
            },
          })
          .eq('line_user_id', userId)
      }
      continue
    }

    // ── State: selecting_makeup_slot ──────────────────────────────────────────
    if (currentState === 'selecting_makeup_slot') {
      const availableSlots: SlotEntry[] = stateData.available_slots ?? []
      const { day_th, time_slot } = stateData
      const num = parseInt(messageText, 10)

      if (isNaN(num) || num < 1 || num > availableSlots.length) {
        const lines = ['📅 เลือกวันชดเชย:\n']
        availableSlots.forEach((s, i) => {
          lines.push(`${numEmoji(i)} ${s.day} ${s.slot}`)
        })
        lines.push('\nพิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
        await replyMessage(replyToken, lines.join('\n'))
        continue
      }

      const makeup = availableSlots[num - 1]

      await db.from('absences').insert({
        line_user_id: userId,
        student_name: displayName,
        absent_date: day_th,
        absent_time: time_slot,
        makeup_date: makeup.day,
        makeup_time: makeup.slot,
        status: 'pending',
      })

      await resetState(db, userId)

      await replyMessage(replyToken, [
        '✅ บันทึกการลาแล้วครับ',
        `📅 วันที่ลา: ${day_th} ${time_slot}`,
        `🔁 วันชดเชยที่ขอ: ${makeup.day} ${makeup.slot}`,
        '',
        'รอครูยืนยันนะครับ 🙏',
      ].join('\n'))

      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          '🔔 มีคำขอลา!',
          `👤 ${displayName}`,
          `📅 ลา: ${day_th} ${time_slot}`,
          `🔁 ขอชดเชย: ${makeup.day} ${makeup.slot}`,
          '',
          'ไปยืนยันที่ Admin Panel',
        ].join('\n'))
      }
      continue
    }

    // ── State: awaiting_confirm_info ──────────────────────────────────────────
    if (currentState === 'awaiting_confirm_info') {
      const { booking_id, instrument, package: pkg, day_th, time_slot } = stateData

      // Parse: last word as phone if it looks like a number, rest as name
      const parts = messageText.trim().split(/\s+/)
      const lastPart = parts[parts.length - 1]
      const isPhone = /^[0-9\-+]{8,}$/.test(lastPart.replace(/-/g, ''))
      const phone = isPhone ? lastPart : ''
      const name = isPhone ? parts.slice(0, -1).join(' ') : messageText

      await db.from('bookings')
        .update({ student_name: name || messageText, phone: phone || null })
        .eq('id', booking_id)

      await resetState(db, userId)

      await replyMessage(replyToken, [
        '✅ ได้รับข้อมูลแล้วครับ!',
        `👤 ${name || messageText}`,
        phone ? `📞 ${phone}` : '',
        `🎸 ${instrument} · ${pkg}`,
        `📅 ${day_th} ${time_slot}`,
        '',
        'รอครูยืนยันและติดต่อกลับนะครับ 🙏',
      ].filter(Boolean).join('\n'))

      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          '🔔 นักเรียนยืนยันการจองแล้ว!',
          `👤 ${name || messageText}`,
          phone ? `📞 ${phone}` : '',
          `🎸 ${instrument} · ${pkg}`,
          `📅 ${day_th} ${time_slot}`,
          '',
          '👉 ยืนยันได้ที่: https://twofour-studio.vercel.app/?admin',
        ].filter(Boolean).join('\n'))
      }
      continue
    }
  }

  return new Response('ok', { status: 200 })
})
