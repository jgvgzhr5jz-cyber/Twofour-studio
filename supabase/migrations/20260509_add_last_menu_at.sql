alter table line_followers
  add column if not exists last_menu_at timestamptz;
