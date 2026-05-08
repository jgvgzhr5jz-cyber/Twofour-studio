import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHANNEL_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN') ?? ''
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

serve(async () => {
  const db = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: followers } = await db.from('line_followers').select('line_user_id, display_name')
  const results = []

  for (const f of followers ?? []) {
    if (f.line_user_id === 'TEST_USER_123') continue
    const link = `https://twofour-studio.vercel.app?luid=${f.line_user_id}`
    const text = `สวัสดี ${f.display_name}! 🎵\n\n👇 กดลิงก์นี้เพื่อจองคอร์ส ระบบจะจำ LINE ของคุณอัตโนมัติ แจ้งเตือนได้เลยโดยไม่ต้องพิมพ์ชื่อซ้ำ:\n${link}`
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: f.line_user_id, messages: [{ type: 'text', text }] })
    })
    results.push({ name: f.display_name, status: res.status })
  }

  return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } })
})
