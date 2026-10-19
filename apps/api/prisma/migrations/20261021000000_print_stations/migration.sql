-- Printing: the machines, their printers, and one row per piece of paper.
--
-- A station is a browser tab on a shop machine. The server cannot hold a
-- USB handle — a WebUSB grant lives in the browser, per origin, and cannot
-- be serialised — so what is stored here is a device_key the page matches
-- against navigator.usb.getDevices() after a reload.
--
-- There is no print_jobs queue. order_events is already the record of what
-- happened; a queue beside it would be a second source of truth with a
-- lifecycle to maintain and rows to garbage-collect, for a guarantee the
-- unique index below already provides.

CREATE TYPE "PrintJob"           AS ENUM ('token', 'kitchen', 'bill');
CREATE TYPE "PrintTransport"     AS ENUM ('usb', 'serial');
CREATE TYPE "PrintReceiptStatus" AS ENUM ('claimed', 'printed', 'failed');

CREATE TABLE print_stations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Refreshed every time the station asks for work. The owner's list reads
  -- this to say "last seen 3 minutes ago", which is the only honest answer
  -- to "is that machine on?" available from a server.
  last_seen_at timestamptz(6),
  -- Revoked rather than deleted: the receipts that point at it are the
  -- record of what was printed, and that record should survive a machine
  -- being retired.
  revoked_at   timestamptz(6),
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL
);

CREATE INDEX print_stations_business_idx ON print_stations (business_id, revoked_at);

CREATE TABLE station_outputs (
  id           uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  station_id   uuid NOT NULL REFERENCES print_stations(id) ON DELETE CASCADE,
  job          "PrintJob" NOT NULL,
  -- What Chrome reported, so the settings list can name the machine in
  -- words its owner recognises.
  device_label text NOT NULL,
  -- vendorId:productId:serial. The page re-finds the granted device by this.
  device_key   text NOT NULL,
  transport    "PrintTransport" NOT NULL,
  paper_width  smallint NOT NULL,
  created_at   timestamptz(6) NOT NULL DEFAULT now(),
  updated_at   timestamptz(6) NOT NULL,

  -- One output per job per station. This is what makes both deployment
  -- modes fall out of the same data with no mode flag: two machines each
  -- holding different jobs, or one machine holding all three.
  CONSTRAINT station_outputs_station_id_job_key UNIQUE (station_id, job),
  CONSTRAINT station_outputs_paper_width_check CHECK (paper_width IN (58, 80))
);

CREATE TABLE print_receipts (
  id          bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  station_id  uuid NOT NULL REFERENCES print_stations(id) ON DELETE CASCADE,
  event_id    bigint NOT NULL REFERENCES order_events(id) ON DELETE CASCADE,
  job         "PrintJob" NOT NULL,
  attempt     int NOT NULL DEFAULT 1,
  status      "PrintReceiptStatus" NOT NULL DEFAULT 'claimed',
  claimed_at  timestamptz(6) NOT NULL DEFAULT now(),
  printed_at  timestamptz(6),
  error       text,

  -- The claim. A second tab racing for the same token hits this and skips.
  -- A constraint rather than application code, for the same reason
  -- orders_one_open_per_table is one: it holds under concurrency, and the
  -- alternative is two slips for one order with nothing to say which.
  CONSTRAINT print_receipts_claim_key UNIQUE (station_id, event_id, job, attempt)
);

-- The `pending` query: everything this station has already taken, for the
-- events in the window. business_id leads so the scan is tenant-local.
CREATE INDEX print_receipts_station_event_idx ON print_receipts (station_id, event_id);
CREATE INDEX print_receipts_business_idx      ON print_receipts (business_id, claimed_at);

-- ─── Only an owner may put a bill on a machine ──────────────────────────────
--
-- A bill is prices, and a kitchen account sees no prices anywhere else in
-- this product — the board, the notifications and the order payload are all
-- stripped. Paper would be the hole. A trigger rather than a service check
-- because the service is not the only thing that can write this table, and
-- this is the same shape as orders_kitchen_guard.
CREATE OR REPLACE FUNCTION station_outputs_bill_owner_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.job <> 'bill' THEN
    RETURN NEW;
  END IF;

  -- No app user at all is a migration or a seed, not a request.
  IF app_current_user_id() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM businesses
     WHERE id = NEW.business_id AND owner_id = app_current_user_id()
  ) THEN
    RAISE EXCEPTION 'only the owner may attach a bill printer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER station_outputs_bill_guard
  BEFORE INSERT OR UPDATE ON station_outputs
  FOR EACH ROW EXECUTE FUNCTION station_outputs_bill_owner_only();

-- ─── RLS, in the same shape as the rest ─────────────────────────────────────

ALTER TABLE print_stations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE station_outputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_receipts  ENABLE ROW LEVEL SECURITY;

CREATE POLICY print_stations_owner ON print_stations
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));
CREATE POLICY station_outputs_owner ON station_outputs
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));
CREATE POLICY print_receipts_owner ON print_receipts
  USING      (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()))
  WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = app_current_user_id()));

-- Kitchen staff run the machine in the kitchen. They set it up, link its
-- printer and report results — all of it, except putting a bill on it,
-- which the trigger above refuses.
CREATE POLICY print_stations_kitchen_read ON print_stations FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_stations_kitchen_touch ON print_stations FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY station_outputs_kitchen_read ON station_outputs FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY station_outputs_kitchen_update ON station_outputs FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_receipts_kitchen_read ON print_receipts FOR SELECT
  USING (business_id IN (SELECT app_staff_business_ids()));

CREATE POLICY print_receipts_kitchen_update ON print_receipts FOR UPDATE
  USING      (business_id IN (SELECT app_staff_business_ids()))
  WITH CHECK (business_id IN (SELECT app_staff_business_ids()));

-- ─── The kitchen's three writes, through a door instead of a policy ────────
--
-- This codebase holds an invariant, asserted by kitchen-policies.spec.ts
-- ("creates no kitchen INSERT or DELETE policy"): the kitchen role never
-- gets a direct INSERT anywhere. `order_events` already has the same need
-- and the same answer — `log_order_status_event` is SECURITY DEFINER
-- precisely because order_events has no kitchen INSERT policy.
--
-- Printing follows that precedent rather than widening the boundary. Each
-- function re-checks the caller itself, because SECURITY DEFINER means RLS
-- is not going to.

CREATE OR REPLACE FUNCTION app_may_use_business(p_business_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM businesses
                  WHERE id = p_business_id AND owner_id = app_current_user_id())
      OR p_business_id IN (SELECT app_staff_business_ids());
$$;

CREATE OR REPLACE FUNCTION create_print_station(p_business_id uuid, p_name text)
RETURNS print_stations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row print_stations;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO print_stations (business_id, name, updated_at)
  VALUES (p_business_id, p_name, now())
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- Upsert, because re-linking is the normal repair when a printer is swapped
-- and the unique (station, job) index means a second row cannot exist.
CREATE OR REPLACE FUNCTION attach_station_output(
  p_business_id uuid, p_station_id uuid, p_job "PrintJob",
  p_device_label text, p_device_key text, p_transport "PrintTransport",
  p_paper_width smallint)
RETURNS station_outputs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row station_outputs;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM print_stations
                  WHERE id = p_station_id AND business_id = p_business_id
                    AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'no such station' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO station_outputs (business_id, station_id, job, device_label,
                               device_key, transport, paper_width, updated_at)
  VALUES (p_business_id, p_station_id, p_job, p_device_label,
          p_device_key, p_transport, p_paper_width, now())
  ON CONFLICT (station_id, job) DO UPDATE
    SET device_label = EXCLUDED.device_label,
        device_key   = EXCLUDED.device_key,
        transport    = EXCLUDED.transport,
        paper_width  = EXCLUDED.paper_width,
        updated_at   = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- THE CLAIM. The unique violation is allowed to propagate: the caller turns
-- it into a 409, and that error IS the concurrency control.
CREATE OR REPLACE FUNCTION claim_print_receipt(
  p_business_id uuid, p_station_id uuid, p_event_id bigint,
  p_job "PrintJob", p_attempt int)
RETURNS print_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row print_receipts;
BEGIN
  IF NOT app_may_use_business(p_business_id) THEN
    RAISE EXCEPTION 'not your business' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM print_stations
                  WHERE id = p_station_id AND business_id = p_business_id
                    AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'no such station' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_events
                  WHERE id = p_event_id AND business_id = p_business_id) THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO print_receipts (business_id, station_id, event_id, job, attempt)
  VALUES (p_business_id, p_station_id, p_event_id, p_job, p_attempt)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION app_may_use_business(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_print_station(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION attach_station_output(uuid, uuid, "PrintJob", text, text, "PrintTransport", smallint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_print_receipt(uuid, uuid, bigint, "PrintJob", int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_may_use_business(uuid) TO menu_app;
GRANT EXECUTE ON FUNCTION create_print_station(uuid, text) TO menu_app;
GRANT EXECUTE ON FUNCTION attach_station_output(uuid, uuid, "PrintJob", text, text, "PrintTransport", smallint) TO menu_app;
GRANT EXECUTE ON FUNCTION claim_print_receipt(uuid, uuid, bigint, "PrintJob", int) TO menu_app;

GRANT SELECT, INSERT, UPDATE ON print_stations  TO menu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON station_outputs TO menu_app;
GRANT SELECT, INSERT, UPDATE ON print_receipts  TO menu_app;
GRANT USAGE, SELECT ON SEQUENCE print_receipts_id_seq TO menu_app;
