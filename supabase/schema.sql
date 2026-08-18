-- Planned persistence layer for V0.2. The V0.1 UI uses localStorage.
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  game_mode text not null check (game_mode in ('regular', 'pve', 'pvp-season')),
  season_number integer not null default 0,
  level integer not null default 1,
  roubles bigint not null default 0 check (roubles >= 0),
  dollars bigint not null default 0 check (dollars >= 0),
  euros bigint not null default 0 check (euros >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, game_mode, season_number)
);

create table if not exists hideout_progress (
  profile_id uuid not null references profiles(id) on delete cascade,
  station_id text not null,
  current_level integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (profile_id, station_id)
);

create table if not exists item_inventory (
  profile_id uuid not null references profiles(id) on delete cascade,
  item_id text not null,
  quantity integer not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, item_id)
);

create table if not exists task_progress (
  profile_id uuid not null references profiles(id) on delete cascade,
  task_id text not null,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (profile_id, task_id)
);
