-- Enable pg_cron and pg_net extensions (if not already enabled)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 17:00 Bangkok (10:00 UTC) — แจ้งเตือนสำหรับพรุ่งนี้
select cron.schedule(
  'remind-tomorrow',
  '0 10 * * *',
  $$
    select net.http_post(
      url := 'https://cwktzexjynavgshdlvhw.supabase.co/functions/v1/remind-students',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_4lqHvl0baVHhPKbloiGWQw_fbaYWHpq"}'::jsonb,
      body := '{"mode": "tomorrow"}'::jsonb
    )
  $$
);

-- 08:00 Bangkok (01:00 UTC) — แจ้งเตือนสำหรับวันนี้
select cron.schedule(
  'remind-today',
  '0 1 * * *',
  $$
    select net.http_post(
      url := 'https://cwktzexjynavgshdlvhw.supabase.co/functions/v1/remind-students',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_4lqHvl0baVHhPKbloiGWQw_fbaYWHpq"}'::jsonb,
      body := '{"mode": "today"}'::jsonb
    )
  $$
);
