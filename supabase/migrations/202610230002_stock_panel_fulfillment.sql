-- Entrega de pedidos usando o estoque do painel para fruits-physical e
-- digital_inventory para produtos que exigem credenciais.
create or replace function public.fulfill_digital_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_product public.products%rowtype;
  v_quantity integer;
  v_available integer;
  v_inventory_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'fulfilled' then return; end if;
  if v_order.status <> 'paid' then raise exception 'order_not_paid'; end if;

  -- Valida todo o pedido antes de descontar estoque ou entregar credenciais.
  for v_item in
    select oi.product_id, sum(oi.quantity)::integer as quantity
    from public.order_items oi
    where oi.order_id = p_order_id
    group by oi.product_id
    order by oi.product_id
  loop
    select * into v_product
    from public.products
    where id = v_item.product_id
    for update;
    if not found then raise exception 'product_not_found'; end if;

    if v_product.category = 'fruits-physical' then
      if not coalesce(v_product.infinite_stock, false)
         and coalesce(v_product.stock_quantity, 0) < v_item.quantity then
        raise exception 'insufficient_stock';
      end if;
    else
      select count(*)::integer into v_available
      from public.digital_inventory
      where product_id = v_item.product_id and status = 'available';
      if v_available < v_item.quantity then raise exception 'insufficient_stock'; end if;
    end if;
  end loop;

  -- Finaliza cada linha de pedido. Para frutas físicas, desconta o estoque
  -- numérico administrado no painel. Para os demais produtos, entrega credenciais.
  for v_item in
    select oi.product_id, sum(oi.quantity)::integer as quantity
    from public.order_items oi
    where oi.order_id = p_order_id
    group by oi.product_id
    order by oi.product_id
  loop
    select * into v_product from public.products where id = v_item.product_id for update;
    if v_product.category = 'fruits-physical' then
      if not coalesce(v_product.infinite_stock, false) then
        update public.products
        set stock_quantity = coalesce(stock_quantity, 0) - v_item.quantity,
            updated_at = now()
        where id = v_item.product_id
          and coalesce(stock_quantity, 0) >= v_item.quantity;
        if not found then raise exception 'insufficient_stock'; end if;
      end if;
    else
      for v_inventory_id in
        select id from public.digital_inventory
        where product_id = v_item.product_id and status = 'available'
        order by created_at, id
        for update skip locked
        limit v_item.quantity
      loop
        update public.digital_inventory
        set status = 'delivered', order_id = p_order_id,
            delivered_to = v_order.user_id, delivered_at = now()
        where id = v_inventory_id and status = 'available';
        if not found then raise exception 'inventory_race'; end if;
      end loop;
    end if;
  end loop;

  update public.orders
  set status = 'fulfilled', fulfilled_at = now(), updated_at = now()
  where id = p_order_id and status = 'paid';
end;
$$;

revoke all on function public.fulfill_digital_order(uuid) from public, anon, authenticated;
grant execute on function public.fulfill_digital_order(uuid) to service_role;
