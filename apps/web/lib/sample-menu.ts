import type { PublicMenu } from "@menu/shared";

/**
 * A stand-in menu for the signup screen and for the template picker before an
 * owner has added anything of their own.
 *
 * Written with real dishes and real prices rather than "Item 1 / ₹100",
 * because the point of showing it is to let someone judge how their menu will
 * look, and placeholder text makes a layout impossible to judge.
 */
export function sampleMenu(overrides?: Partial<PublicMenu["theme"]>): PublicMenu {
  return {
    business: {
      id: "sample",
      name: "Kumar Coffee House",
      type: "cafe",
      logoUrl: null,
      address: {
        line1: "12 Residency Road",
        line2: null,
        city: "Bengaluru",
        state: "Karnataka",
        postalCode: "560025",
        country: "IN",
      },
      currency: "INR",
      publicCode: "SAMPLE00",
    },
    theme: {
      layout: "editorial",
      accent: "#9A6700",
      fontPairing: "inter-fraunces",
      ...overrides,
    },
    updatedAt: new Date().toISOString(),
    categories: [
      {
        id: "c1",
        name: "Coffee",
        items: [
          {
            id: "i1",
            name: "Filter coffee",
            price: null,
            description: "Chicory blend, brewed overnight, served in a tumbler.",
            dietTag: "veg",
            spiceLevel: null,
            prepTimeMins: 4,
            ingredients: "Coffee, chicory, milk, sugar",
            allergens: ["milk"],
            nutrition: null,
            variants: [
              { id: "v1", name: "Single", price: "60.00" },
              { id: "v2", name: "Double", price: "95.00" },
            ],
            photos: [],
          },
          {
            id: "i2",
            name: "Cold brew",
            price: "180.00",
            description: "Steeped 18 hours. Served black over ice.",
            dietTag: "vegan",
            spiceLevel: null,
            prepTimeMins: null,
            ingredients: null,
            allergens: [],
            nutrition: null,
            variants: [],
            photos: [],
          },
        ],
      },
      {
        id: "c2",
        name: "All day",
        items: [
          {
            id: "i3",
            name: "Masala dosa",
            price: "140.00",
            description: "Potato masala, coconut chutney, sambar.",
            dietTag: "veg",
            spiceLevel: 2,
            prepTimeMins: 12,
            ingredients: null,
            allergens: ["mustard"],
            nutrition: null,
            variants: [],
            photos: [],
          },
          {
            id: "i4",
            name: "Chicken cutlet",
            price: "210.00",
            description: "Kerala spice mix, crumbed and shallow fried.",
            dietTag: "non_veg",
            spiceLevel: 3,
            prepTimeMins: null,
            ingredients: null,
            allergens: ["egg", "gluten"],
            nutrition: null,
            variants: [],
            photos: [],
          },
        ],
      },
    ],
  };
}
