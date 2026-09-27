-- Order notifications.
--
-- Two tables and one function. The function is the interesting part: every
-- stored notification is triggered by a *diner*, who has no
-- app.current_user_id, so RLS correctly refuses an ordinary insert. It is
-- SECURITY DEFINER for the same reason place_table_round is.

-- ── Tables ───────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  -- Identity and cursor in one column: clients refetch `?since=<id>` on
  -- every wake-up, so a broadcast that never arrived costs nothing.
  id          bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: retiring a table must not erase the record that
  -- its orders were once announced.
  table_id    uuid REFERENCES tables(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz(6) NOT NULL DEFAULT now(),
  read_at     timestamptz(6)
);

-- The only read the board ever does: this business, newer than this cursor.
CREATE INDEX notifications_business_id_id_idx ON notifications (business_id, id);

-- The unread badge, which is read on every page load.
CREATE INDEX notifications_unread_idx
  ON notifications (business_id) WHERE read_at IS NULL;

CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Unique: re-subscribing the same browser must update this row, not add a
  -- second one that delivers every notification twice.
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  last_seen_at timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_id_idx ON push_subscriptions (user_id);

-- ── Isolation ────────────────────────────────────────────────────────────

ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  FORCE  ROW LEVEL SECURITY;

CREATE POLICY notifications_owner ON notifications
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

-- Scoped to the user, not to a business: a push subscription belongs to a
-- device someone signed in on, and an owner with two restaurants has one.
CREATE POLICY push_subscriptions_self ON push_subscriptions
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications      TO menu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions TO menu_app;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq TO menu_app;

-- ── Emission ─────────────────────────────────────────────────────────────

-- Writes the notification and returns it together with every push
-- subscription belonging to the business's owner.
--
-- The two are returned together deliberately. Web Push needs the
-- subscriptions immediately, the owner is not readable from the diner's
-- connection either, and the database is ~400ms away — so the alternative is
-- a second definer function and another round trip on the hot path of
-- placing an order.
CREATE OR REPLACE FUNCTION emit_staff_notification(
  p_business_id uuid,
  p_order_id    uuid,
  p_table_id    uuid,
  p_kind        text,
  p_title       text,
  p_body        text,
  p_data        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   notifications%ROWTYPE;
  v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM businesses WHERE id = p_business_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'No such business: %', p_business_id;
  END IF;

  INSERT INTO notifications (business_id, order_id, table_id, kind, title, body, data)
  VALUES (p_business_id, p_order_id, p_table_id, p_kind, p_title, p_body,
          COALESCE(p_data, '{}'::jsonb))
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'notification', jsonb_build_object(
      'id',        v_row.id::text,
      'kind',      v_row.kind,
      'title',     v_row.title,
      'body',      v_row.body,
      'data',      v_row.data,
      'orderId',   v_row.order_id,
      'tableId',   v_row.table_id,
      'createdAt', to_char(v_row.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'readAt',    NULL
    ),
    'subscriptions', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
                'endpoint', s.endpoint,
                'p256dh',   s.p256dh,
                'auth',     s.auth))
         FROM push_subscriptions s
        WHERE s.user_id = v_owner),
      '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION emit_staff_notification(uuid, uuid, uuid, text, text, text, jsonb) TO menu_app;

-- ── get_table_order gains the table label and currency ───────────────────
--
-- Purely additive. A staff notification has to say *which* table ordered,
-- and the label was previously only reachable through get_table_context —
-- a second round trip to a database ~400ms away, on the one path where a
-- diner is watching a spinner. Returning it here costs a join on a query
-- that already runs.
--
-- The diner screen benefits too: it currently fetches the label separately
-- from /public/table/session.
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
               'batch',    i.batch
             ) ORDER BY i.batch, i.created_at)
      FROM order_items i WHERE i.order_id = o.id
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
    AND o.status IN ('placed', 'preparing', 'ready');
$$;
