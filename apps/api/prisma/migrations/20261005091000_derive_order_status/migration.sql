-- orders.status stops being written by hand.
--
-- The column stays, because four things read it and would all have to be
-- rewritten if it went: the orders_one_open_per_table partial unique index
-- (the only thing stopping a table getting two bills), get_table_order, the
-- board's status filter, and the kitchen RLS policies. Deriving keeps every
-- one of them correct for free.
--
-- WARNING: the open-status list below is the fifth hand-written copy. See
-- apps/api/src/orders/transitions.ts.

CREATE OR REPLACE FUNCTION derive_order_status(p_order_id uuid)
RETURNS "OrderStatus"
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    -- The least advanced live round. An order is not ready while some part
    -- of it has not been started.
    (SELECT r.status
     FROM order_rounds r
     WHERE r.order_id = p_order_id
       AND r.status IN ('placed','accepted','preparing','ready')
     ORDER BY array_position(
       ARRAY['placed','accepted','preparing','ready']::"OrderStatus"[], r.status)
     LIMIT 1),
    -- Everything is terminal. One completed round means food was served and
    -- a bill is owed; only an entirely cancelled order is cancelled.
    --
    -- HAVING, not WHERE: an aggregate over no rows still returns a row, and
    -- bool_or over no rows is NULL, so without it this branch would answer
    -- 'cancelled' for an order with no rounds and the branch below would be
    -- dead code. The cast is needed for the same reason — the two literals
    -- are otherwise text, which COALESCE cannot match against "OrderStatus".
    (SELECT CASE WHEN bool_or(r.status = 'completed')
                 THEN 'completed' ELSE 'cancelled' END::"OrderStatus"
     FROM order_rounds r WHERE r.order_id = p_order_id
     HAVING count(*) > 0),
    -- No rounds at all: reachable mid-transaction inside place_table_round,
    -- and again if the last round of an order is ever deleted. Stay inside
    -- the open set and out of billing. Mirrors deriveOrderStatus()'s
    -- `if (roundStatuses.length === 0) return "placed"`.
    'placed'::"OrderStatus"
  );
$$;

-- Left as SECURITY INVOKER, deliberately.
--
-- The UPDATE below therefore runs under the RLS and the BEFORE UPDATE guards
-- of whoever moved the round, and both of those have been checked against
-- every writer that exists:
--
--   * kitchen staff — orders_kitchen_write grants UPDATE on exactly the
--     orders of the venues they are staff of, which is exactly the set of
--     orders whose rounds order_rounds_kitchen_update lets them touch. A
--     kitchen write only ever derives a *live* status, and derives 'placed'
--     only for an order already sitting in 'placed', so the status whitelist
--     in orders_kitchen_guard is never reached; completed_at is only written
--     on the way into or out of a terminal state, which a kitchen round
--     write cannot cause. (A kitchen attempt to reopen a completed order by
--     pulling one of its rounds back to 'ready' is the exception, and it is
--     rejected by that guard — which is the wanted answer.)
--   * owners — orders_owner is FOR ALL, and the guards' staff lookup misses,
--     so the owner path is untouched.
--   * place_table_round and the other diner-facing functions — SECURITY
--     DEFINER, so RLS is out of the picture entirely.
--
-- SECURITY DEFINER here would buy nothing (the guards are triggers; they
-- fire either way) and would cost the invariant that writing a round can
-- never move an order the writer could not have moved directly.
CREATE OR REPLACE FUNCTION order_rounds_derive_status_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_status   "OrderStatus";
BEGIN
  v_status := derive_order_status(v_order_id);

  UPDATE orders SET
    status = v_status,
    -- Set on the way into a terminal state, cleared on the way out of one.
    -- An order can leave 'completed' only if a round is reopened, which the
    -- state machine forbids; clearing is belt and braces.
    completed_at = CASE
                     WHEN v_status IN ('completed','cancelled')
                       THEN COALESCE(completed_at, now())
                     ELSE NULL
                   END,
    updated_at = now()
  WHERE id = v_order_id AND (status IS DISTINCT FROM v_status OR updated_at < now());

  RETURN NULL;
END;
$$;

CREATE TRIGGER order_rounds_derive_status
AFTER INSERT OR UPDATE OF status OR DELETE ON order_rounds
FOR EACH ROW EXECUTE FUNCTION order_rounds_derive_status_fn();

GRANT EXECUTE ON FUNCTION derive_order_status(uuid) TO menu_app;
