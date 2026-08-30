import { z } from "zod";
import { BUSINESS_TYPES, DIET_TAGS, OTP_PURPOSES } from "./enums";
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
});
export type BusinessUpdateInput = z.infer<typeof businessUpdateSchema>;

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
