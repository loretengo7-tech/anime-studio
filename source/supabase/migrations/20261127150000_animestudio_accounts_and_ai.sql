-- AnimeStudio: accounts, subscriptions and AI usage (applied to the project via the Supabase connector).
-- Users can READ their own rows only. Plan / admin / usage are written ONLY by the server
-- (edge functions with the service role), so nobody can give themselves Pro from the app.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'none' check (status in ('none', 'trialing', 'active', 'past_due', 'paused', 'canceled')),
  plan text not null default 'pro',
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('template', 'chat')),
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_user_month on public.ai_usage (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.ai_usage enable row level security;

create policy "own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own subscription" on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy "own usage" on public.ai_usage for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.profiles, public.subscriptions, public.ai_usage from anon;
revoke insert, update, delete on public.profiles, public.subscriptions, public.ai_usage from authenticated;
grant select on public.profiles, public.subscriptions, public.ai_usage to authenticated;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into public.subscriptions (user_id) values (new.id);
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
