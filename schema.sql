
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text default 'Reader',
  city text,
  created_at timestamptz default now()
);

create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null,
  body text not null,
  category text default 'India',
  city text,
  author_name text default 'GENWIRE Desk',
  source_urls jsonb default '[]'::jsonb,
  is_ai_generated boolean default false,
  is_published boolean default false,
  published_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.debates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  status text default 'open',
  created_at timestamptz default now()
);

create table if not exists public.debate_posts (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid references public.debates(id) on delete cascade,
  author_id uuid references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz default now()
);

create table if not exists public.editions (
  id uuid primary key default gen_random_uuid(),
  edition_date date unique not null,
  title text not null,
  intro text,
  content jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
alter table public.articles enable row level security;
alter table public.debates enable row level security;
alter table public.debate_posts enable row level security;
alter table public.editions enable row level security;

create policy "Public profiles read"
on public.profiles for select using (true);

create policy "Read published articles"
on public.articles for select using (is_published = true);

create policy "Read debates"
on public.debates for select using (status = 'open');

create policy "Read debate posts"
on public.debate_posts for select using (true);

create policy "Read editions"
on public.editions for select using (true);
