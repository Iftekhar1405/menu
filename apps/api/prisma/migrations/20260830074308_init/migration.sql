-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'platform_admin');

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('restaurant', 'cafe', 'theatre');

-- CreateEnum
CREATE TYPE "DietTag" AS ENUM ('veg', 'non_veg', 'vegan', 'egg');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('verify', 'recover');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "pin_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "verified_at" TIMESTAMPTZ(6),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "BusinessType" NOT NULL,
    "logo_path" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "public_code" TEXT NOT NULL,
    "vanity_slug" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "theme_layout" TEXT NOT NULL DEFAULT 'editorial',
    "theme_accent" TEXT NOT NULL DEFAULT '#1D6F5C',
    "theme_font" TEXT NOT NULL DEFAULT 'inter-fraunces',
    "google_place_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "menu_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2),
    "description" TEXT,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "diet_tag" "DietTag",
    "spice_level" INTEGER,
    "prep_time_mins" INTEGER,
    "ingredients" TEXT,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nutrition" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_variants" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "menu_item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_photos" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "alt" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "menu_item_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_views" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "viewed_on" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "menu_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "otp_challenges_user_id_purpose_idx" ON "otp_challenges"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_public_code_key" ON "businesses"("public_code");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_vanity_slug_key" ON "businesses"("vanity_slug");

-- CreateIndex
CREATE INDEX "businesses_owner_id_idx" ON "businesses"("owner_id");

-- CreateIndex
CREATE INDEX "menu_categories_business_id_position_idx" ON "menu_categories"("business_id", "position");

-- CreateIndex
CREATE INDEX "menu_items_business_id_idx" ON "menu_items"("business_id");

-- CreateIndex
CREATE INDEX "menu_items_category_id_position_idx" ON "menu_items"("category_id", "position");

-- CreateIndex
CREATE INDEX "menu_item_variants_item_id_position_idx" ON "menu_item_variants"("item_id", "position");

-- CreateIndex
CREATE INDEX "menu_item_variants_business_id_idx" ON "menu_item_variants"("business_id");

-- CreateIndex
CREATE INDEX "menu_item_photos_item_id_position_idx" ON "menu_item_photos"("item_id", "position");

-- CreateIndex
CREATE INDEX "menu_item_photos_business_id_idx" ON "menu_item_photos"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_views_business_id_viewed_on_key" ON "menu_views"("business_id", "viewed_on");

-- AddForeignKey
ALTER TABLE "otp_challenges" ADD CONSTRAINT "otp_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_photos" ADD CONSTRAINT "menu_item_photos_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_views" ADD CONSTRAINT "menu_views_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
