/**
 * Navigation entries carry no icon. The icons are React components defined in
 * the layout, and keeping them out of here is what lets this file be tested
 * in a node environment — the layout maps href to icon when it renders.
 */
export interface NavItem {
  href: string;
  label: string;
}

export type Role = "owner" | "kitchen" | "platform_admin";

const OWNER_NAV: NavItem[] = [
  { href: "/dashboard",  label: "Overview" },
  { href: "/orders",     label: "Orders" },
  { href: "/menu",       label: "Menu" },
  { href: "/tables",     label: "Tables" },
  { href: "/billing",    label: "Billing" },
  { href: "/appearance", label: "Menu design" },
  { href: "/qr",         label: "QR code" },
  { href: "/merch",      label: "Printed cards" },
  { href: "/settings",   label: "Settings" },
];

const KITCHEN_NAV: NavItem[] = [
  { href: "/orders", label: "Orders" },
  { href: "/dishes", label: "Dishes" },
];

const ADMIN_NAV: NavItem[] = [{ href: "/admin", label: "Card orders" }];

/**
 * Navigation is derived per role, not filtered from one list.
 *
 * The old shape appended an extra entry for platform admins, which worked
 * because they see everything an owner does plus one. A kitchen user needs a
 * *different* list, not a longer one, and filtering a nine-item array by
 * predicate is how a section ends up visible because someone forgot to add
 * it to the deny list.
 */
export function navFor(role: Role): NavItem[] {
  switch (role) {
    case "kitchen":        return KITCHEN_NAV;
    case "platform_admin": return [...OWNER_NAV, ...ADMIN_NAV];
    default:               return OWNER_NAV;
  }
}

/**
 * `/station` is reachable by every role but appears in no one's sidebar: it
 * is the screen that stays open on a shop machine all day, reached by a
 * bookmark on that machine rather than by navigating in from a staff
 * member's own session. `navFor` deliberately does not offer it.
 */
const ALLOWED: Record<Role, string[]> = {
  kitchen: ["/orders", "/dishes", "/change-pin", "/station"],
  owner: ["/dashboard", "/orders", "/menu", "/tables", "/billing",
          "/appearance", "/qr", "/merch", "/settings", "/change-pin", "/station"],
  platform_admin: ["/dashboard", "/orders", "/menu", "/tables", "/billing",
                   "/appearance", "/qr", "/merch", "/settings", "/admin", "/change-pin", "/station"],
};

/**
 * Cosmetic only. There is no middleware.ts in this app, so this stops a
 * mistyped URL rendering a broken screen — it is not the security boundary.
 * That is the API and the RLS policies behind it.
 */
export function canSee(role: Role, pathname: string): boolean {
  return ALLOWED[role].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
