
-- Suporte por tickets ligados a pedidos pagos.
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null default 'Suporte sobre pedido',
  status text not null default 'open' check (status in ('open','waiting_customer','waiting_admin','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete restrict,
  sender_email text not null,
  sender_role text not null check (sender_role in ('customer','admin')),
  message text not null check (length(message) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index if not exists support_tickets_user_updated_idx on public.support_tickets(user_id, updated_at desc);
create index if not exists support_messages_ticket_created_idx on public.support_messages(ticket_id, created_at);
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
drop policy if exists "Ticket owner or store owner can read tickets" on public.support_tickets;
create policy "Ticket owner or store owner can read tickets" on public.support_tickets
 for select to authenticated using (
   auth.uid() = user_id or lower(coalesce(auth.jwt()->>'email','')) = 'administradorsupreme@gmail.com'
 );
drop policy if exists "Ticket owner or store owner can read messages" on public.support_messages;
create policy "Ticket owner or store owner can read messages" on public.support_messages
 for select to authenticated using (
   exists (select 1 from public.support_tickets t where t.id = ticket_id
     and (t.user_id = auth.uid() or lower(coalesce(auth.jwt()->>'email','')) = 'administradorsupreme@gmail.com'))
 );
-- Inserções/alterações são feitas pelas APIs server-side, nunca diretamente pelo navegador.
revoke all on public.support_tickets from anon, authenticated;
grant select on public.support_tickets to authenticated;
revoke all on public.support_messages from anon, authenticated;
grant select on public.support_messages to authenticated;


-- Anexos privados das mensagens (imagens, PDFs e documentos).
create extension if not exists pgcrypto;
alter table public.support_messages add column if not exists attachments jsonb not null default '[]'::jsonb;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-attachments', 'support-attachments', false, 10485760, array['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "Ticket participants can upload support attachments" on storage.objects;
create policy "Ticket participants can upload support attachments" on storage.objects for insert to authenticated with check (
 bucket_id = 'support-attachments' and (
  exists (select 1 from public.support_tickets t where t.id::text = (storage.foldername(name))[1] and t.user_id = auth.uid())
  or (lower(coalesce(auth.jwt()->>'email','')) = 'administradorsupreme@gmail.com' and exists (select 1 from public.support_tickets t where t.id::text = (storage.foldername(name))[1]))
 ) and (storage.foldername(name))[2] = auth.uid()::text
);
drop policy if exists "Ticket participants can read support attachments" on storage.objects;
create policy "Ticket participants can read support attachments" on storage.objects for select to authenticated using (
 bucket_id = 'support-attachments' and (
  exists (select 1 from public.support_tickets t where t.id::text = (storage.foldername(name))[1] and t.user_id = auth.uid())
  or (lower(coalesce(auth.jwt()->>'email','')) = 'administradorsupreme@gmail.com' and exists (select 1 from public.support_tickets t where t.id::text = (storage.foldername(name))[1]))
 )
);
