alter table students
  add column if not exists phone text,
  add column if not exists line_display_name text;
