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

// ─── Helper: push LINE message ───────────────────────────────────────────────
async function pushMessage(to: string, text: string) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
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
    const userId = event.source?.userId
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
      await pushMessage(userId, [
        `สวัสดี ${displayName}! 🎵`,
        `ยินดีต้อนรับสู่ TWOFOUR Studio`,
        ``,
        `พิมพ์ "ดูตาราง" เพื่อดูช่วงว่างและจองคลาส`,
        `พิมพ์ "แจ้งลา" เพื่อแจ้งขาดเรียน`,
        ``,
        `หรือกดลิงก์นี้เพื่อจองผ่านเว็บ:`,
        bookingLink,
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

      await pushMessage(userId, 'ได้รับสลิปแล้วครับ ✅\nครูจะตรวจสอบและยืนยันการจองให้เร็วๆ นี้นะครับ 🙏')

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
        await pushMessage(userId, '↩️ ยกเลิกแล้วครับ')
      }
      continue
    }

    // ── No active state ───────────────────────────────────────────────────────
    if (!currentState) {
      if (messageText === 'ดูตาราง') {
        const slots = await getAvailableSlots(db)
        if (slots.length === 0) {
          await pushMessage(userId, 'ขณะนี้ไม่มีช่วงว่าง กรุณาติดต่อครูโดยตรงครับ')
        } else {
          await pushMessage(userId, buildSlotList(slots))
          await db.from('line_followers')
            .update({ state: 'selecting_slot', state_data: { ts: Date.now(), slots } })
            .eq('line_user_id', userId)
        }

      } else if (messageText === 'สนใจ' || messageText === 'สนใจเรียน' || messageText === 'อยากเรียน' || messageText === 'สอบถาม') {
        const bookingLink = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`
        await pushMessage(userId, [
          `สวัสดีครับ ${displayName ? displayName + ' ' : ''}ยินดีต้อนรับสู่ TWOFOUR Studio 🎵`,
          '',
          '🔗 กดลิงก์นี้เพื่อดูตารางและจองคลาส:',
          bookingLink,
          '',
          'ระบบจะจำ LINE ของคุณอัตโนมัติครับ — จองเสร็จแล้วจะได้รับการยืนยันทาง LINE เลย 🙏',
        ].join('\n'))

      } else if (messageText === 'แจ้งลา') {
        const { data: bookings } = await db
          .from('bookings')
          .select('id, instrument, day_th, time_slot')
          .eq('line_user_id', userId)
          .in('status', ['confirmed', 'pending'])
          .order('created_at', { ascending: false })
          .limit(5)

        if (!bookings || bookings.length === 0) {
          await pushMessage(userId, 'ไม่พบคลาสที่จองไว้ครับ')
        } else {
          const lines = ['📚 คลาสของคุณ:\n']
          bookings.forEach((b: { id: string; instrument: string; day_th: string; time_slot: string }, i: number) => {
            lines.push(`${numEmoji(i)} ${b.instrument} · ${b.day_th} ${b.time_slot}`)
          })
          lines.push('\nพิมพ์หมายเลขที่ต้องการลา')
          await pushMessage(userId, lines.join('\n'))
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
        // Unknown message — send booking link + menu (max once per day)
        if (!sentMenuToday()) {
          const bookingLink = `https://twofour-studio.vercel.app?luid=${userId}&t=${Date.now()}`
          await pushMessage(userId, [
            `สวัสดีครับ ${displayName ? displayName + ' ' : ''}👋`,
            '',
            '🔗 กดลิงก์นี้เพื่อดูตารางและจองคลาส:',
            bookingLink,
            '',
            'หรือพิมพ์คำสั่งด้านล่าง:',
            '📅 "ดูตาราง" — ดูช่วงว่างและจองผ่านแชท',
            '🙏 "แจ้งลา" — แจ้งขาดเรียน',
          ].join('\n'))
          await markMenuSent()
        }
      }
      continue
    }

    // ── State: selecting_slot ─────────────────────────────────────────────────
    if (currentState === 'selecting_slot') {
      const slots: SlotEntry[] = stateData.slots ?? []
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > slots.length) {
        await pushMessage(userId, 'กรุณาพิมพ์หมายเลขที่ถูกต้องครับ')
        continue
      }
      const chosen = slots[num - 1]
      await pushMessage(userId, buildInstrumentList())
      await db.from('line_followers')
        .update({
          state: 'selecting_instrument',
          state_data: { ts: Date.now(), slot_day: chosen.day, slot_time: chosen.slot },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: selecting_instrument ───────────────────────────────────────────
    if (currentState === 'selecting_instrument') {
      const num = parseInt(messageText, 10)
      if (isNaN(num) || num < 1 || num > INSTRUMENTS.length) {
        await pushMessage(userId, buildInstrumentList())
        continue
      }
      const instrument = INSTRUMENTS[num - 1]
      await pushMessage(userId, buildPackageList())
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
        await pushMessage(userId, buildPackageList())
        continue
      }
      const pkg = PACKAGES[num - 1]
      await pushMessage(userId, '👤 ชื่อที่ต้องการให้ครูเรียก?')
      await db.from('line_followers')
        .update({
          state: 'entering_name',
          state_data: {
            ts: Date.now(),
            slot_day: stateData.slot_day,
            slot_time: stateData.slot_time,
            instrument: stateData.instrument,
            package: pkg,
          },
        })
        .eq('line_user_id', userId)
      continue
    }

    // ── State: entering_name ──────────────────────────────────────────────────
    if (currentState === 'entering_name') {
      const name = messageText
      const { slot_day, slot_time, instrument, package: pkg } = stateData
      const status = pkg === 'ทดลองเรียนฟรี (20 นาที)' ? 'trial' : 'pending'

      await db.from('bookings').insert({
        instrument,
        package: pkg,
        day_th: slot_day,
        time_slot: slot_time,
        status,
        student_name: name,
        line_user_id: userId,
      })

      await resetState(db, userId)

      await pushMessage(userId, [
        '✅ จองเรียบร้อยแล้ว!',
        `👤 ${name}`,
        `🎸 ${instrument} · ${pkg}`,
        `📅 ${slot_day} ${slot_time}`,
        '',
        'รอครูยืนยันภายใน 24 ชม. นะครับ 🙏',
      ].join('\n'))

      if (ADMIN_LINE_ID) {
        await pushMessage(ADMIN_LINE_ID, [
          '🔔 มีการจองใหม่! (จากไลน์)',
          `👤 ${name}`,
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
        await pushMessage(userId, lines.join('\n'))
        continue
      }

      const chosen = bookingList[num - 1]
      const availableSlots = await getAvailableSlots(db)

      await pushMessage(userId, [
        `📅 ลา: ${chosen.instrument} · ${chosen.day_th} ${chosen.time_slot}`,
        '',
        'ต้องการนัดวันชดเชยไหมครับ?',
        '',
        '1️⃣ เลือกวันชดเชยเอง',
        '2️⃣ ให้ครูเลือกให้',
      ].join('\n'))

      await db.from('line_followers')
        .update({
          state: 'selecting_makeup_pref',
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
      continue
    }

    // ── State: selecting_makeup_pref ──────────────────────────────────────────
    if (currentState === 'selecting_makeup_pref') {
      const { day_th, time_slot, available_slots } = stateData
      const availableSlots: SlotEntry[] = available_slots ?? []

      if (messageText === '1' || messageText === 'เลือกเอง') {
        if (availableSlots.length === 0) {
          // No available slots — auto-delegate to admin
          await db.from('absences').insert({
            line_user_id: userId,
            student_name: displayName,
            absent_date: day_th,
            absent_time: time_slot,
            status: 'pending',
          })
          await resetState(db, userId)
          await pushMessage(userId, '✅ บันทึกการลาแล้วครับ\nครูจะแจ้งวันชดเชยให้เร็วๆ นี้ 🙏')
          if (ADMIN_LINE_ID) {
            await pushMessage(ADMIN_LINE_ID, [
              '🔔 มีคำขอลา!',
              `👤 ${displayName}`,
              `📅 ${day_th} ${time_slot}`,
              '',
              'นักเรียนให้ครูเลือกวันชดเชย (ไม่มีช่วงว่าง)',
            ].join('\n'))
          }
        } else {
          const lines = ['📅 เลือกวันชดเชย:\n']
          availableSlots.forEach((s, i) => {
            lines.push(`${numEmoji(i)} ${s.day} ${s.slot}`)
          })
          lines.push('\nพิมพ์หมายเลขที่ต้องการ หรือพิมพ์ "ยกเลิก" เพื่อออก')
          await pushMessage(userId, lines.join('\n'))
          await db.from('line_followers')
            .update({
              state: 'selecting_makeup_slot',
              state_data: { ...stateData, ts: Date.now() },
            })
            .eq('line_user_id', userId)
        }

      } else if (messageText === '2' || messageText === 'ให้ครูเลือก') {
        await db.from('absences').insert({
          line_user_id: userId,
          student_name: displayName,
          absent_date: day_th,
          absent_time: time_slot,
          status: 'pending',
        })
        await resetState(db, userId)
        await pushMessage(userId, '✅ บันทึกการลาแล้วครับ\nครูจะแจ้งวันชดเชยให้เร็วๆ นี้ 🙏')
        if (ADMIN_LINE_ID) {
          await pushMessage(ADMIN_LINE_ID, [
            '🔔 มีคำขอลา!',
            `👤 ${displayName}`,
            `📅 ${day_th} ${time_slot}`,
            '',
            'นักเรียนให้ครูเลือกวันชดเชย',
          ].join('\n'))
        }

      } else {
        await pushMessage(userId, 'กรุณาพิมพ์ 1 หรือ 2 ครับ')
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
        await pushMessage(userId, lines.join('\n'))
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

      await pushMessage(userId, [
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
  }

  return new Response('ok', { status: 200 })
})
