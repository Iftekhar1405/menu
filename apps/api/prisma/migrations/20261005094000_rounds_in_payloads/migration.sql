-- get_table_order: hand both screens the rounds, not just the items.
--
-- Rounds became first-class rows with their own status, KOT number and
-- timestamps, but this payload still flattened them away — every reader got
-- one undifferentiated list of items and an order-level status that cannot
-- say "the chai is ready, the dosa is not". The `rounds` array is what the
-- kitchen board prints a KOT from and what the diner's screen groups by.
--
-- The flat `items` array stays exactly as it is, deliberately:
--   * the diner's order screen reads it and is not part of this change;
--   * notifications/events.ts picks the newest round out of it with
--     `Math.max(...items.map(i => i.batch))`, so the `batch` key is load
--     bearing today. It is the round's seq, read through the round that
--     owns the item (20261005093000_place_round_per_round).
--
-- CREATE OR REPLACE of the whole function: the body below is the live
-- definition from 20261005093000_place_round_per_round plus the one new key.
CREATE OR REPLACE FUNCTION get_table_order(p_table_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id',          o.id,
    'status',      o.status,
    'isRunning',   o.is_running,
    'dailyNumber', o.daily_number,
    'placedAt',    to_char(o.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'tableLabel',  t.label,
    'currency',    b.currency,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',       i.id,
               'name',     i.name_snapshot,
               'variant',  i.variant_snapshot,
               'unitPrice', i.unit_price::text,
               'quantity', i.quantity,
               'batch',    r.seq
             ) ORDER BY r.seq, i.created_at)
      FROM order_items i
      JOIN order_rounds r ON r.id = i.round_id
      WHERE i.order_id = o.id
    ), '[]'::jsonb),
    'rounds', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',        r.id,
               'seq',       r.seq,
               'kotNumber', r.kot_number,
               'status',    r.status,
               'placedAt',  to_char(r.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', i.id, 'name', i.name_snapshot,
                          'variant', i.variant_snapshot,
                          'unitPrice', i.unit_price::text,
                          'quantity', i.quantity
                        ) ORDER BY i.created_at)
                 FROM order_items i WHERE i.round_id = r.id
               ), '[]'::jsonb)
             ) ORDER BY r.seq)
      FROM order_rounds r WHERE r.order_id = o.id
    ), '[]'::jsonb),
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id',   e.id,
               'kind', e.kind,
               'at',   to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
               'data', e.data
             ) ORDER BY e.id)
      FROM order_events e WHERE e.order_id = o.id
    ), '[]'::jsonb),
    'total', COALESCE((
      SELECT SUM(i.unit_price * i.quantity)::text
      FROM order_items i WHERE i.order_id = o.id
    ), '0')
  )
  FROM orders o
  JOIN tables t     ON t.id = o.table_id
  JOIN businesses b ON b.id = o.business_id
  WHERE o.table_id = p_table_id
    AND (
      -- Open orders: always return.
      o.status IN ('placed', 'accepted', 'preparing', 'ready')
      OR
      -- Recently closed: a diner re-scanning after their order was served
      -- should see their receipt, not an empty screen. 2h is long enough to
      -- cover a meal; after that the table has almost certainly turned over.
      (o.status IN ('completed', 'cancelled')
       AND o.placed_at > now() - interval '2 hours')
    )
  ORDER BY
    -- Open orders first, then most recent. A table may have a completed order
    -- from earlier and a new open one; the open one is always what is wanted.
    CASE WHEN o.status IN ('placed','accepted','preparing','ready') THEN 0 ELSE 1 END,
    o.placed_at DESC
  LIMIT 1;
$$;
