import type { BusinessType, DietTag, ThemeLayout } from "@menu/shared";

/** Shapes the API returns to the dashboard. */

export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: "owner" | "platform_admin";
  verified: boolean;
}

export interface Business {
  id: string;
  name: string;
  type: BusinessType;
  logoPath: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
  publicCode: string;
  vanitySlug: string | null;
  currency: string;
  themeLayout: ThemeLayout;
  themeAccent: string;
  themeFont: string;
}

export interface Variant {
  id: string;
  name: string;
  price: string;
  position: number;
}

export interface Photo {
  id: string;
  storagePath: string;
  alt: string | null;
  position: number;
}

export interface Item {
  id: string;
  categoryId: string;
  name: string;
  price: string | null;
  description: string | null;
  isAvailable: boolean;
  position: number;
  dietTag: DietTag | null;
  spiceLevel: number | null;
  prepTimeMins: number | null;
  ingredients: string | null;
  allergens: string[];
  nutrition: Record<string, number | string> | null;
  /** Null falls back to the business default rate. */
  taxRate: string | null;
  variants: Variant[];
  photos: Photo[];
}

export interface Category {
  id: string;
  name: string;
  position: number;
  isVisible: boolean;
  items: Item[];
}

export interface Summary {
  categories: number;
  items: number;
  itemsMissingPhotos: number;
  views7: number;
  views30: number;
}

export interface UploadTicket {
  uploadUrl: string;
  path: string;
  driver: "cloudinary" | "supabase" | "local";
  /** Cloudinary only: multipart fields that must accompany the file. */
  fields?: Record<string, string>;
}
