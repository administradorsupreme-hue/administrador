-- Execute depois da migration 202610240002_kaneki_new_admin.sql.
-- Não altera o status de pagamentos nem marca pedidos como entregues.
INSERT INTO public.kaneki_tickets(order_id,user_id)
SELECT o.id,o.user_id
FROM public.orders o
WHERE o.status IN ('paid','fulfilled')
AND EXISTS (
 SELECT 1 FROM public.order_items oi
 JOIN public.products p ON p.id=oi.product_id
 WHERE oi.order_id=o.id AND p.delivery_type='ticket'
)
ON CONFLICT(order_id) DO NOTHING;
