import { z } from "zod";

/**
 * Environment is parsed once at boot and fails loudly. A missing JWT secret
 * should stop the process, not surface as a 500 three hours into a shift.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /**
   * The runtime connection. Must be a NON-superuser role, because table
   * owners and superusers bypass row-level security entirely — pointing
   * this at the migration role would silently disable every policy.
   * Falls back to DATABASE_URL so tooling still works.
   */
  APP_DATABASE_URL: z.string().default(""),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  PUBLIC_MENU_BASE_URL: z.string().url().default("http://localhost:3000"),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  REVALIDATE_SECRET: z.string().min(8),

  /**
   * No WhatsApp/email credentials yet, so accounts are marked verified at
   * signup and OTPs are logged by the console driver. Flip to false the day
   * real drivers are configured — it is an env change, not a code change.
   */
  AUTH_SKIP_VERIFICATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  SUPABASE_STORAGE_BUCKET: z.string().default("business-assets"),

  WHATSAPP_PHONE_NUMBER_ID: z.string().default(""),
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
  WHATSAPP_OTP_TEMPLATE: z.string().default("otp_verification"),
  RESEND_API_KEY: z.string().default(""),
  RESEND_FROM: z.string().default("Menu <noreply@menu.irad.solutions>"),

  SEED_ADMIN_EMAIL: z.string().default("admin@irad.solutions"),
  SEED_ADMIN_PIN: z.string().regex(/^\d{6}$/).default("204815"),
  SEED_ADMIN_NAME: z.string().default("Platform Admin"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when Supabase Storage is configured; otherwise uploads go to local disk. */
export function usesSupabaseStorage(env: Env): boolean {
  return env.SUPABASE_URL.length > 0 && env.SUPABASE_SERVICE_ROLE_KEY.length > 0;
}
