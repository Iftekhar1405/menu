export const BUSINESS_TYPES = ["restaurant", "cafe", "theatre"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const DIET_TAGS = ["veg", "non_veg", "vegan", "egg"] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const USER_ROLES = ["owner", "platform_admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const OTP_PURPOSES = ["verify", "recover"] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/** Human labels for diet tags, used on the public menu and in the builder. */
export const DIET_TAG_LABEL: Record<DietTag, string> = {
  veg: "Veg",
  non_veg: "Non-veg",
  vegan: "Vegan",
  egg: "Contains egg",
};

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  restaurant: "Restaurant",
  cafe: "Cafe",
  theatre: "Movie theatre",
};

/** 0-3. Rendered as chilli glyphs; 0 means "not spicy" and is not shown. */
export const SPICE_LEVEL_LABEL: Record<number, string> = {
  0: "Not spicy",
  1: "Mild",
  2: "Medium",
  3: "Hot",
};

/* ── Cancelling an order ─────────────────────────────────────────────────── */

/**
 * Why a diner called an order back.
 *
 * A fixed list rather than something each owner writes for themselves. The
 * whole value of asking is that the answers stack up — "it was taking too
 * long", said two hundred times across a month, is a kitchen problem, and it
 * only reads that way if every business says it with the same word.
 */
export const CANCELLATION_REASONS = [
  "mistake",
  "changed_mind",
  "wrong_item",
  "too_slow",
  "other",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Written as a diner would say it, because a diner is who picks from this. */
export const CANCELLATION_REASON_LABEL: Record<CancellationReason, string> = {
  mistake: "Ordered it by mistake",
  changed_mind: "Changed my mind",
  wrong_item: "Ordered the wrong thing",
  too_slow: "It's taking too long",
  other: "Something else",
};

/** The same reasons from the owner's side of the counter, for reports. */
export const CANCELLATION_REASON_STAFF_LABEL: Record<CancellationReason, string> = {
  mistake: "Ordered by mistake",
  changed_mind: "Changed their mind",
  wrong_item: "Ordered the wrong thing",
  too_slow: "Taking too long",
  other: "Something else",
};

/**
 * "Something else" tells the owner nothing on its own, so choosing it makes
 * the remark mandatory. Every other reason already carries its own meaning
 * and a forced explanation would only teach diners to type "asdf".
 */
export function cancellationRemarkRequired(reason: CancellationReason): boolean {
  return reason === "other";
}

/**
 * The order statuses an owner may still allow cancelling in.
 *
 * `completed` and `cancelled` are absent by construction: one has been
 * served and the other already is cancelled.
 */
export const CANCELLABLE_STATUSES = ["placed", "preparing", "ready"] as const;
export type CancellableStatus = (typeof CANCELLABLE_STATUSES)[number];

/** Matches the words the kitchen board uses for the same columns. */
export const CANCELLABLE_STATUS_LABEL: Record<CancellableStatus, string> = {
  placed: "Sent to the kitchen",
  preparing: "Being made",
  ready: "Ready",
};

/**
 * How long after a table is served a new order from that table still counts
 * as the same party coming back.
 *
 * The bounds are what keep the flag meaningful. Below the minimum almost
 * nothing qualifies; above the maximum almost everything does, and a
 * priority signal that fires on every table is not a priority signal. The
 * database carries the same range as a CHECK on `businesses`.
 */
export const RUNNING_ORDER_WINDOW = { min: 5, max: 180, default: 45 } as const;
