-- order_rounds_kitchen_guard stops leaving completed_at open.
--
-- As first committed in 20261005090000_order_rounds the guard forbade a
-- kitchen account the status 'completed' while leaving the column that
-- records a completion free to write. Those two say the same thing about the
-- same round, and guarding one of them is not a rule — it is half of one. A
-- kitchen account could stamp a round completed_at, and the next reader of
-- that column would believe it.
--
-- orders_kitchen_guard, the precedent this guard was modelled on, has always
-- pinned the equivalent orders.completed_at: see the compared-column list in
-- 20261004034321_rbac_kitchen_guards_fix, where status is the ONLY column a
-- kitchen write may move. The two guards now agree.
--
-- accepted_at stays writable, and that is not an inconsistency. 'accepted' IS
-- a status the kitchen may set — it is in the whitelist three lines down — so
-- the timestamp recording it is a timestamp a kitchen write legitimately
-- produces. 'completed' and 'cancelled' are not, so the timestamp recording
-- those is not. The rule is the same in both cases: a kitchen account may
-- write the mark of a status it is allowed to set, and nothing else.
--
-- Nothing in the application loses an ability here. setRoundStatus writes
-- completed_at only on the move to 'completed' or 'cancelled', which the role
-- check has already refused a kitchen user before any SQL is sent — and for
-- every other move it leaves the column out of the UPDATE entirely rather
-- than naming it, so the comparison below is never even reached.

CREATE OR REPLACE FUNCTION order_rounds_kitchen_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_staff
     WHERE user_id = app_current_user_id()
       AND business_id = OLD.business_id
       AND status = 'active'
  ) THEN
    RETURN NEW;  -- not staff: the owner path is unchanged
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('accepted', 'preparing', 'ready') THEN
    RAISE EXCEPTION 'kitchen staff may not set round status to %', NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- Every column except the two a kitchen write is for: status, and the
  -- accepted_at that records the one status change producing a timestamp the
  -- kitchen may produce. Compared one by one rather than through to_jsonb, so
  -- that the day someone adds a column this fails loudly instead of silently
  -- letting the new column through.
  IF NEW.id           IS DISTINCT FROM OLD.id
  OR NEW.business_id  IS DISTINCT FROM OLD.business_id
  OR NEW.order_id     IS DISTINCT FROM OLD.order_id
  OR NEW.seq          IS DISTINCT FROM OLD.seq
  OR NEW.business_day IS DISTINCT FROM OLD.business_day
  OR NEW.kot_number   IS DISTINCT FROM OLD.kot_number
  OR NEW.placed_at    IS DISTINCT FROM OLD.placed_at
  OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
    RAISE EXCEPTION 'kitchen staff may only change a round''s status'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;
