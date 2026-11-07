"use client";

import Link from "next/link";
import { useSession } from "@/components/session";
import { useSignOut } from "@/components/sign-out";
import { ThemeToggle } from "@/components/theme-toggle";

const ROLE_LABEL = {
  owner: "Owner",
  kitchen: "Kitchen staff",
  platform_admin: "Platform admin",
} as const;

/**
 * The one screen every role has for its own account.
 *
 * A kitchen user's nav is two sections long, which never fills the mobile
 * tab bar, so the More sheet — where Sign out lives for owners — never
 * appears for them. This page is what gives them a way out, a way to change
 * their PIN, and the dark-mode switch the desktop sidebar carries.
 */
export default function AccountPage() {
  const { me, current } = useSession();
  const signOut = useSignOut();

  return (
    <div className="mx-auto max-w-2xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Account</h1>
        <p className="mt-1 text-[14.5px] text-muted">Your profile and this device.</p>
      </header>

      <div className="space-y-6">
        <section className="rounded-2xl border border-line bg-surface px-5 py-4">
          <p className="text-[16px] font-semibold text-ink">{me?.fullName}</p>
          <p className="mt-0.5 text-[13.5px] text-muted">{me?.email ?? me?.phone}</p>
          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
            <dt className="text-faint">Role</dt>
            <dd className="text-ink">{me ? ROLE_LABEL[me.role] : ""}</dd>
            {current && (
              <>
                <dt className="text-faint">Business</dt>
                <dd className="truncate text-ink">{current.name}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="rounded-2xl border border-line bg-surface px-5 py-4">
          <ThemeToggle />
        </section>

        <ul className="overflow-hidden rounded-2xl border border-line">
          <li>
            <Link
              href="/change-pin"
              className="spring flex h-[52px] items-center justify-between bg-surface px-5 text-[15px] text-ink hover:bg-[rgba(var(--accent-rgb),0.06)]"
            >
              Change PIN
              <span aria-hidden="true" className="text-faint">›</span>
            </Link>
          </li>
        </ul>

        <button
          type="button"
          onClick={() => void signOut()}
          className="spring h-12 w-full rounded-2xl border border-line bg-surface text-[15px] text-muted hover:border-[var(--accent-soft)] hover:text-[var(--accent)]"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
