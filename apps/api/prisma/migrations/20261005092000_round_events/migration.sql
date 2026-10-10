-- Status changes happen to rounds now, so the log of them follows.
--
-- The trigger on `orders` is deliberately NOT removed. It keeps logging the
-- order's own transitions, which is what the diner's "your table is settled"
-- line reads and what the bill will hang off. Round events and order events
-- are different facts about different things.

ALTER TABLE order_events ADD COLUMN round_id uuid REFERENCES order_rounds(id) ON DELETE CASCADE;
CREATE INDEX order_events_round_idx ON order_events (round_id, id);

-- SECURITY DEFINER, same reason as log_order_status_event() next door
-- (see 20261004035044_rbac_kitchen_audit): order_events has no INSERT policy
-- for kitchen staff, only order_events_owner (ALL, owner-only) and
-- order_events_kitchen_read (SELECT). A round's status is most often moved
-- by kitchen staff, not the owner, so without SECURITY DEFINER this INSERT
-- would be refused by RLS for that actor and take the whole round UPDATE
-- down with it.
CREATE OR REPLACE FUNCTION order_rounds_log_status_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  INSERT INTO order_events (order_id, business_id, round_id, kind, data, actor_id)
  VALUES (
    NEW.order_id, NEW.business_id, NEW.id,
    'round.' || NEW.status::text,
    jsonb_build_object('seq', NEW.seq, 'kotNumber', NEW.kot_number),
    -- Set by the API before it writes; null for anything the database did
    -- on its own, which is honest: we do not know who.
    NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER order_rounds_log_status
AFTER UPDATE OF status ON order_rounds
FOR EACH ROW EXECUTE FUNCTION order_rounds_log_status_fn();
