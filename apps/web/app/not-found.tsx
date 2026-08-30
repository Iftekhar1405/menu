import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <h1 className="font-display text-[24px] font-semibold tracking-tight">
          No menu here
        </h1>
        <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
          This link may have been mistyped, or the business hasn&apos;t published
          their menu yet. Check the code on the card and try again.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block text-[14px] font-medium text-[var(--accent)] hover:underline"
        >
          I run this business
        </Link>
      </div>
    </main>
  );
}
