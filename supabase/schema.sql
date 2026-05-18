-- JuriScan — Supabase Schema
-- Run this in Supabase SQL Editor

create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  plan text not null default 'free',
  scans_used integer not null default 0,
  scans_reset_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─── Scan history ─────────────────────────────────────────────────────────────

create table public.scan_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  document_type text,
  compliance_score integer,
  status text,
  missing jsonb default '[]',
  summary text,
  scan_type text,
  created_at timestamptz not null default now()
);

alter table public.scan_history enable row level security;

create policy "Users can read own scans"
  on public.scan_history for select using (auth.uid() = user_id);
