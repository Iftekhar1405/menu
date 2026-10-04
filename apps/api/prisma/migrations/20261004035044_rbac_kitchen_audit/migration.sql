-- Part 4: who did it.
--
-- The trigger runs inside the request transaction, where app.current_user_id
-- is already set, so the actor costs nothing extra to record. Null means a
-- diner, the system, or anything from before staff accounts existed.
--
-- SECURITY DEFINER and SET search_path TO 'public' are preserved from the
-- current deployed function: order_events has no INSERT policy for kitchen
-- (only order_events_owner / ALL and order_events_kitchen_read / SELECT), so
-- without SECURITY DEFINER this INSERT would be refused by RLS for a kitchen
-- actor and the whole status UPDATE would fail.
CREATE OR REPLACE FUNCTION public.log_order_status_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO order_events (order_id, business_id, kind, actor_id)
  VALUES (NEW.id, NEW.business_id, NEW.status::text, app_current_user_id());
  RETURN NULL;
END;
$function$;
