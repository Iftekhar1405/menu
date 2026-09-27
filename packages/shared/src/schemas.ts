import { z } from "zod";
import {
  BUSINESS_TYPES,
  CANCELLABLE_STATUSES,
  CANCELLATION_REASONS,
  DIET_TAGS,
  OTP_PURPOSES,
  RUNNING_ORDER_WINDOW,
  cancellationRemarkRequired,
} from "./enums";
import {
  SHEET_ORIENTATIONS,
  SHEET_PAPERS,
  SHEET_SIZES,
  SHEET_STYLES,
} from "./qr-sheet";
import { THEME_LAYOUTS } from "./theme-tokens";

/**
 * Validation shared by the Nest DTOs and the web forms, so a rule can never
 * drift between the two. The API still re-validates everything — the client
 * copy exists to give fast feedback, not to be trusted.
 */

/** Login credential. Six digits, nothing else. */
export const pinSchema = z
  .string()
  .regex(/^\d{6}$/, "PIN must be exactly 6 digits");

/** Email or phone. Which one it is gets resolved server-side. */
export const identifierSchema = z
  .string()
  .trim()
  .min(3, "Enter your email or phone number")
  .max(254);

export const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, "Country must be a 2-letter code")
  .default("IN");

export const signupSchema = z.object({
  identifier: identifierSchema,
  pin: pinSchema,
  fullName: z.string().trim().min(1, "Enter your name").max(120),
  businessName: z.string().trim().min(1, "Enter your business name").max(120),
  businessType: z.enum(BUSINESS_TYPES),
  country: countryCodeSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  identifier: identifierSchema,
  pin: pinSchema,
  country: countryCodeSchema.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const otpRequestSchema = z.object({
  identifier: identifierSchema,
  purpose: z.enum(OTP_PURPOSES),
  country: countryCodeSchema.optional(),
});
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  identifier: identifierSchema,
  purpose: z.enum(OTP_PURPOSES),
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
  country: countryCodeSchema.optional(),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

export const pinResetSchema = z.object({
  identifier: identifierSchema,
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
  newPin: pinSchema,
  country: countryCodeSchema.optional(),
});
export type PinResetInput = z.infer<typeof pinResetSchema>;

/** Slugs an owner may not claim, because we route on them. */
const RESERVED_SLUGS = [
  "admin", "api", "app", "auth", "dashboard", "login", "signup", "m",
  "menu", "settings", "static", "support", "qr", "public", "help",
];

export const vanitySlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "Use 3-40 letters, numbers, or hyphens")
  .refine((s) => !RESERVED_SLUGS.includes(s), "That name is reserved");

export const businessUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.enum(BUSINESS_TYPES).optional(),
  addressLine1: z.string().trim().max(160).nullish(),
  addressLine2: z.string().trim().max(160).nullish(),
  city: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  country: countryCodeSchema.optional(),
  logoPath: z.string().max(400).nullish(),
  themeLayout: z.enum(THEME_LAYOUTS).optional(),
  themeAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  themeFont: z.string().max(60).optional(),
  vanitySlug: vanitySlugSchema.nullish(),

  cancellationEnabled: z.boolean().optional(),
  // Minutes, and capped at two hours. A window longer than that is not a
  // change-of-mind window, it is an unbilled order waiting to happen.
  cancellationWindowMins: z.number().int().min(1).max(120).optional(),
  // An empty array is allowed and means nobody can cancel, which is a
  // coherent thing for an owner to have ticked their way into.
  cancellationStatuses: z.array(z.enum(CANCELLABLE_STATUSES)).max(3).optional(),
  cancellationItemsEnabled: z.boolean().optional(),

  runningOrderEnabled: z.boolean().optional(),
  // Minutes. The bounds are what keep the flag meaningful rather than
  // arbitrary: below RUNNING_ORDER_WINDOW.min nothing ever qualifies, above
  // its max every table does, and a priority that fires on everything is not
  // a priority. The database carries the same range as a CHECK.
  runningOrderWindowMins: z
    .number()
    .int()
    .min(RUNNING_ORDER_WINDOW.min, `Use at least ${RUNNING_ORDER_WINDOW.min} minutes`)
    .max(RUNNING_ORDER_WINDOW.max, `Use at most ${RUNNING_ORDER_WINDOW.max} minutes`)
    .optional(),
});
export type BusinessUpdateInput = z.infer<typeof businessUpdateSchema>;

/**
 * What a diner sends to call an order back.
 *
 * `lines` absent means the whole order. The API re-checks the window, the
 * order's status and the owner's settings inside the same transaction that
 * writes the cancellation — nothing here is load-bearing for safety, it only
 * makes the phone say the right thing a moment sooner.
 */
export const cancelOrderSchema = z
  .object({
    lines: z
      .array(
        z.object({
          orderItemId: z.string().uuid(),
          quantity: z.number().int().min(1).max(99),
        }),
      )
      .min(1)
      .max(60)
      .nullish(),
    reason: z.enum(CANCELLATION_REASONS),
    remark: z.string().trim().max(300).nullish(),
  })
  .refine((v) => !cancellationRemarkRequired(v.reason) || Boolean(v.remark), {
    message: "Tell us what happened",
    path: ["remark"],
  });
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const categorySchema = z.object({
  name: z.string().trim().min(1, "Category needs a name").max(80),
  isVisible: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;

export const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

const priceSchema = z
  .number()
  .nonnegative("Price cannot be negative")
  .max(9_999_999.99, "Price is too large")
  .multipleOf(0.01, "Price can have at most 2 decimal places");

export const variantSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Size needs a name").max(60),
  price: priceSchema,
});
export type VariantInput = z.infer<typeof variantSchema>;

export const nutritionSchema = z
  .object({
    calories: z.number().nonnegative().optional(),
    proteinG: z.number().nonnegative().optional(),
    carbsG: z.number().nonnegative().optional(),
    fatG: z.number().nonnegative().optional(),
    fibreG: z.number().nonnegative().optional(),
    sugarG: z.number().nonnegative().optional(),
    sodiumMg: z.number().nonnegative().optional(),
    servingSize: z.string().trim().max(60).optional(),
  })
  .strict();

export const photoSchema = z.object({
  id: z.string().uuid().optional(),
  storagePath: z.string().min(1).max(400),
  alt: z.string().trim().max(160).nullish(),
});

/**
 * The core rule of the menu model: an item must carry a price somewhere.
 * Either a base price, or at least one variant that has one. The database
 * enforces the same thing with a constraint trigger — this copy exists so the
 * owner gets a readable message instead of a 500.
 */
export const menuItemSchema = z
  .object({
    name: z.string().trim().min(1, "Item needs a name").max(120),
    price: priceSchema.nullish(),
    description: z.string().trim().max(600).nullish(),
    isAvailable: z.boolean().default(true),
    categoryId: z.string().uuid(),
    // Advanced details — all optional, all hidden behind a disclosure.
    dietTag: z.enum(DIET_TAGS).nullish(),
    spiceLevel: z.number().int().min(0).max(3).nullish(),
    prepTimeMins: z.number().int().min(0).max(600).nullish(),
    ingredients: z.string().trim().max(2000).nullish(),
    allergens: z.array(z.string().trim().max(60)).max(30).default([]),
    nutrition: nutritionSchema.nullish(),
    /** Overrides the business default. Packaged goods differ from food. */
    taxRate: z.number().min(0).max(100).nullish(),
    variants: z.array(variantSchema).max(20).default([]),
    photos: z.array(photoSchema).max(10).default([]),
  })
  .refine(
    (item) => item.price != null || item.variants.length > 0,
    {
      message: "Set a price, or add at least one size with a price",
      path: ["price"],
    },
  )
  .refine(
    (item) => !(item.price != null && item.variants.length > 0),
    {
      message: "An item priced by size cannot also have a single price",
      path: ["price"],
    },
  );
export type MenuItemInput = z.infer<typeof menuItemSchema>;

/**
 * A batch of table cards laid out for printing.
 *
 * The table ids are checked against the business server-side as well — this
 * only establishes that they are ids at all, so a malformed one fails at the
 * edge rather than somewhere inside the PDF writer.
 */
export const qrSheetSchema = z.object({
  tableIds: z
    .array(z.string().uuid())
    .min(1, "Select at least one table")
    .max(500, "Print at most 500 tables at a time"),
  paper: z.enum(SHEET_PAPERS).default("a4"),
  orientation: z.enum(SHEET_ORIENTATIONS).default("portrait"),
  size: z.enum(SHEET_SIZES).default("medium"),
  style: z.enum(SHEET_STYLES).default("card"),
});
export type QrSheetInput = z.infer<typeof qrSheetSchema>;
