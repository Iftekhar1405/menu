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
