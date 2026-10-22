-- KaneKi: esquema inicial para catálogo, pedidos, inventário digital e eventos.
-- Revise o esquema existente e faça backup antes de executar.

create extension if not exists pgcrypto;

create table if not exists public.products (
  id text primary key,
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','paid','fulfilled','cancelled','refunded','failed')),
  currency text not null default 'BRL' check (currency = 'BRL'),
  total_cents integer not null check (total_cents >= 0),
  provider text not null default 'eclipsepay',
  provider_charge_id text unique,
  payment_reference text unique not null default encode(gen_random_bytes(16), 'hex'),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id text not null references public.products(id) on delete restrict,
  product_name text not null,
  unit_price_cents integer not null check (unit_price_cents >= 0),
  quantity integer not null check (quantity between 1 and 10),
  created_at timestamptz not null default now()
);

create table if not exists public.digital_inventory (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id) on delete cascade,
  secret_value text not null,
  status text not null default 'available' check (status in ('available','reserved','delivered')),
  order_id uuid references public.orders(id) on delete set null,
  delivered_to uuid references auth.users(id) on delete set null,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (product_id, secret_value)
);

create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,
  provider_charge_id text,
  event_type text,
  processed_at timestamptz,
  received_at timestamptz not null default now()
);

create index if not exists orders_user_created_idx on public.orders(user_id, created_at desc);
create index if not exists order_items_order_idx on public.order_items(order_id);
create index if not exists digital_inventory_available_idx on public.digital_inventory(product_id, created_at) where status = 'available';

alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.digital_inventory enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists "Anyone can view active products" on public.products;
create policy "Anyone can view active products" on public.products for select using (is_active = true);

drop policy if exists "Users can view own orders" on public.orders;
create policy "Users can view own orders" on public.orders for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can view own order items" on public.order_items;
create policy "Users can view own order items" on public.order_items for select to authenticated using (
  exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid())
);

-- Sem políticas para digital_inventory e payment_webhook_events: somente servidor.
