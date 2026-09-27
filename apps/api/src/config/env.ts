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
  /**
   * A direct (non-pooled) connection for `prisma migrate` and `prisma studio`,
   * which need a real session. DATABASE_URL is the pooled one in production, so
   * the two genuinely differ there; locally they are the same string.
   */
  DIRECT_URL: z.string().default(""),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  /**
   * Browser origins allowed to call the API with credentials, comma-separated.
   * Separate from WEB_ORIGIN because that one is a single URL the API calls
   * back (the revalidate webhook), while CORS needs to admit several — the
   * production site plus however many Netlify preview domains are in play.
   * Empty means "just WEB_ORIGIN".
   */
  CORS_ORIGINS: z.string().default(""),
  /**
   * The refresh cookie's SameSite mode. "lax" is right when the browser talks
   * to one origin; set it to "none" once the web app and the API live on
   * different sites (Netlify and Vercel, say), or the cookie is never sent and
   * every session dies at the first refresh. "none" implies Secure, which is
   * applied below, so it cannot be used over plain http.
   */
  COOKIE_SAMESITE: z.enum(["lax", "none"]).default("lax"),
  PUBLIC_MENU_BASE_URL: z.string().url().default("http://localhost:3000"),

  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  REVALIDATE_SECRET: z.string().min(8),
  /**
   * Signs table sessions. Deliberately separate from the owner token secret:
   * with distinct keys, an owner token presented to a diner route fails to
   * verify outright rather than relying on a scope check being correct.
   */
  TABLE_SESSION_SECRET: z.string().min(8),

  /**
   * No WhatsApp/email credentials yet, so accounts are marked verified at
   * signup and OTPs are logged by the console driver. Flip to false the day
   * real drivers are configured — it is an env change, not a code change.
   */
  AUTH_SKIP_VERIFICATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * The Supabase project URL. Used for two unrelated things — Realtime
   * broadcast and (optionally) Storage — which is why `usesSupabaseStorage`
   * below is explicit about the precedence rather than leaving it to the
   * order call sites happen to check things in.
   */
  SUPABASE_URL: z.string().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(""),
  /** Public key, safe in the browser. Realtime subscribe needs it. */
  SUPABASE_ANON_KEY: z.string().default(""),
  SUPABASE_STORAGE_BUCKET: z.string().default("business-assets"),

  /**
   * Signs Realtime topic names. A business id is not a secret — it is in
   * every dashboard URL — so the topic is an HMAC of it rather than the id
   * itself. See notifications/channel-name.ts.
   */
  REALTIME_CHANNEL_SECRET: z.string().min(8).default("dev-realtime-channel-secret"),

  /**
   * Web Push (VAPID). Inert until both keys are set, at which case staff
   * devices can be pushed to while the dashboard is closed. Generate with
   * `npx web-push generate-vapid-keys`.
   */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:support@irad.solutions"),

  /**
   * Cloudinary. Preferred over Supabase Storage when set, because it
   * transforms at delivery time — the same upload is served as AVIF or WebP
   * at a sensible quality depending on the diner's phone.
   */
  CLOUDINARY_CLOUD_NAME: z.string().default(""),
  CLOUDINARY_API_KEY: z.string().default(""),
  CLOUDINARY_API_SECRET: z.string().default(""),

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

/**
 * Names whose values must never reach a log. Connection URLs are on the list
 * because they carry the password inline.
 */
const SENSITIVE = /SECRET|PASSWORD|TOKEN|_KEY|DATABASE_URL|DIRECT_URL/;

/**
 * The offending value, for the message below.
 *
 * "WEB_ORIGIN: Invalid url" is true and still costs a deploy cycle to act on,
 * because the one thing it withholds is what the variable actually contained —
 * usually an unsubstituted placeholder that looks right at a glance.
 */
function showValue(key: string): string {
  const raw = process.env[key];
  if (raw === undefined) return "nothing";
  if (SENSITIVE.test(key)) return "<redacted>";
  return JSON.stringify(raw);
}

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => {
        const key = i.path.join(".");
        return `  ${key}: ${i.message} (received ${showValue(key)})`;
      })
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** The origins CORS should admit: CORS_ORIGINS if set, else just WEB_ORIGIN. */
export function corsOrigins(env: Env): string[] {
  const listed = env.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return listed.length > 0 ? listed : [env.WEB_ORIGIN];
}

/**
 * Cookie flags for the refresh token. Secure is forced on whenever SameSite is
 * "none" — browsers drop such a cookie outright otherwise, and a cookie that is
 * silently discarded looks exactly like a bug in the auth code.
 */
export function refreshCookieFlags(env: Env): {
  secure: boolean;
  sameSite: "lax" | "none";
} {
  return {
    sameSite: env.COOKIE_SAMESITE,
    secure: env.NODE_ENV === "production" || env.COOKIE_SAMESITE === "none",
  };
}

/**
 * True when Supabase Storage is the active driver.
 *
 * Cloudinary wins when both are configured. That was already the behaviour,
 * but only because every call site happened to test Cloudinary first — an
 * ordering, not a rule. It is stated here because SUPABASE_URL now also
 * enables Realtime: without this, switching notifications on would quietly
 * move where every image is served from.
 */
export function usesSupabaseStorage(env: Env): boolean {
  if (env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET) {
    return false;
  }
  return env.SUPABASE_URL.length > 0 && env.SUPABASE_SERVICE_ROLE_KEY.length > 0;
}

/** True when the API can broadcast Realtime pings. */
export function usesRealtime(env: Env): boolean {
  return env.SUPABASE_URL.length > 0 && env.SUPABASE_SERVICE_ROLE_KEY.length > 0;
}

/** True when staff devices can be pushed to with the dashboard closed. */
export function usesWebPush(env: Env): boolean {
  return env.VAPID_PUBLIC_KEY.length > 0 && env.VAPID_PRIVATE_KEY.length > 0;
}
