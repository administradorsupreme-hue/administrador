-- KANEKI STORE: executar após revisar backup e o esquema existente.
-- Autorize seu usuário: INSERT INTO public.kaneki_admins(user_id) VALUES ('SEU-UUID-AUTH-USERS');
create table if not exists public.kaneki_admins(user_id uuid primary key references auth.users(id));
create or replace function public.kaneki_is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.kaneki_admins where user_id=auth.uid()) $$;
revoke all on function public.kaneki_is_admin() from public;
grant execute on function public.kaneki_is_admin() to authenticated;
alter table public.kaneki_admins enable row level security;
create policy "admins can see own membership" on public.kaneki_admins for select to authenticated using (user_id=auth.uid());
alter table public.products add column if not exists category text not null default 'Outros';
alter table public.products add column if not exists delivery_type text not null default 'ticket';
alter table public.products drop constraint if exists products_delivery_type_check;
alter table public.products add constraint products_delivery_type_check check(delivery_type in ('ticket','automatic'));
create policy "kaneki admins manage products" on public.products for all to authenticated using(public.kaneki_is_admin()) with check(public.kaneki_is_admin());
create policy "kaneki admins see orders" on public.orders for select to authenticated using(public.kaneki_is_admin());
create policy "kaneki admins see order items" on public.order_items for select to authenticated using(public.kaneki_is_admin());
create policy "kaneki admins manage inventory" on public.digital_inventory for all to authenticated using(public.kaneki_is_admin()) with check(public.kaneki_is_admin());
create table if not exists public.kaneki_tickets(id uuid primary key default gen_random_uuid(),order_id uuid not null unique references public.orders(id) on delete cascade,user_id uuid not null references auth.users(id),status text not null default 'open' check(status in ('open','closed')),created_at timestamptz not null default now());
create table if not exists public.kaneki_ticket_messages(id uuid primary key default gen_random_uuid(),ticket_id uuid not null references public.kaneki_tickets(id) on delete cascade,sender_id uuid not null references auth.users(id),body text not null default '',file_path text,created_at timestamptz not null default now());
alter table public.kaneki_tickets enable row level security;
alter table public.kaneki_ticket_messages enable row level security;
create policy "participants read tickets" on public.kaneki_tickets for select to authenticated using(user_id=auth.uid() or public.kaneki_is_admin());
create policy "admins update tickets" on public.kaneki_tickets for update to authenticated using(public.kaneki_is_admin()) with check(public.kaneki_is_admin());
create policy "participants read messages" on public.kaneki_ticket_messages for select to authenticated using(exists(select 1 from public.kaneki_tickets t where t.id=ticket_id and (t.user_id=auth.uid() or public.kaneki_is_admin())));
create policy "participants send messages" on public.kaneki_ticket_messages for insert to authenticated with check(sender_id=auth.uid() and exists(select 1 from public.kaneki_tickets t where t.id=ticket_id and t.status='open' and (t.user_id=auth.uid() or public.kaneki_is_admin())));
-- Ticket criado quando um pedido confirmado contém produto configurado como ticket.
create or replace function public.kaneki_create_paid_ticket() returns trigger language plpgsql security definer set search_path=public as $$ begin
 if new.status in ('paid','fulfilled') and old.status is distinct from new.status and exists(
 select 1 from public.order_items oi join public.products p on p.id=oi.product_id where oi.order_id=new.id and p.delivery_type='ticket'
 ) then insert into public.kaneki_tickets(order_id,user_id) values(new.id,new.user_id) on conflict(order_id) do nothing; end if;
 return new;end $$;
drop trigger if exists kaneki_ticket_on_payment on public.orders;
create trigger kaneki_ticket_on_payment after update of status on public.orders for each row execute function public.kaneki_create_paid_ticket();
-- Buckets: um público para fotos de catálogo; outro privado para anexos.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('kaneki-product-images','kaneki-product-images',true,8000000,array['image/png','image/jpeg','image/webp']) on conflict(id) do nothing;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('kaneki-ticket-files','kaneki-ticket-files',false,8000000,array['image/png','image/jpeg','image/webp','application/pdf']) on conflict(id) do nothing;
create policy "admin uploads product images" on storage.objects for insert to authenticated with check(bucket_id='kaneki-product-images' and public.kaneki_is_admin());
create policy "admin manages product images" on storage.objects for delete to authenticated using(bucket_id='kaneki-product-images' and public.kaneki_is_admin());
create policy "ticket participants read files" on storage.objects for select to authenticated using(bucket_id='kaneki-ticket-files' and exists(select 1 from public.kaneki_tickets t where t.id::text=split_part(name,'/',1) and (t.user_id=auth.uid() or public.kaneki_is_admin())));
create policy "ticket participants upload files" on storage.objects for insert to authenticated with check(bucket_id='kaneki-ticket-files' and split_part(name,'/',2)=auth.uid()::text and exists(select 1 from public.kaneki_tickets t where t.id::text=split_part(name,'/',1) and t.status='open' and (t.user_id=auth.uid() or public.kaneki_is_admin())));
