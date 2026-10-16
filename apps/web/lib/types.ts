import type {
  BusinessType,
  CancellableStatus,
  DietTag,
  OrderStatus,
  ThemeLayout,
} from "@menu/shared";

/** Shapes the API returns to the dashboard. */

export interface Me {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: "owner" | "kitchen" | "platform_admin";
  verified: boolean;
  mustChangePin: boolean;
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
  cancellationEnabled: boolean;
  cancellationWindowMins: number;
  cancellationStatuses: CancellableStatus[];
  cancellationItemsEnabled: boolean;
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

/** One line of an order, as the staff board reads it. */
export interface OrderLine {
  id: string;
  nameSnapshot: string;
  variantSnapshot: string | null;
  // Absent entirely for a kitchen caller: the API strips every price
  // before it leaves the server (Task 7). The client follows the data
  // rather than re-deciding who gets to see it.
  unitPrice?: string;
  quantity: number;
}

/**
 * One batch of items ordered in one go — a KOT.
 *
 * It carries its own status, because a table that adds a chai at nine has not
 * un-cooked the biryani it ordered at eight. The order's own status is
 * derived from these by the database, and `deriveOrderStatus` computes the
 * same answer in the browser.
 */
export interface OrderRound {
  id: string;
  seq: number;
  kotNumber: number;
  status: OrderStatus;
  placedAt: string;
  items: OrderLine[];
}

export interface Order {
  id: string;
  status: OrderStatus;
  dailyNumber: number;
  placedAt: string;
  isRunning: boolean;
  table: { id: string; label: string };
  rounds: OrderRound[];
  /**
   * Every line of every round, flattened. Kept because the totals and the
   * item counts on this screen are facts about the whole order, and nothing
   * is gained by re-flattening the rounds to get them.
   */
  items: OrderLine[];
}
