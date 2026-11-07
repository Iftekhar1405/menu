import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Mark } from "@/components/brand";
import { TourVideo } from "@/components/tour-video";
import { LOCALE_PATH, type Locale } from "@/i18n/locales";
import { BRAND_NAME, COMPANY_URL } from "@/lib/site";
import { HeroStage } from "./hero-stage";
import { LandingMotion, MOTION_BOOTSTRAP } from "./motion";
import { LandingNav } from "./nav";
import { DesignTrio, OrdersBoardMini, TableStand, TicketRail } from "./product-pieces";
import { SessionRedirect } from "./session-redirect";
import { landingJsonLd } from "./seo";
import "./landing.css";

type Step = { title: string; body: string };
type Detail = { title: string; body: string };
type Job = { name: string; note: string };
type Faq = { q: string; a: string };

/**
 * The page a logged-out visitor sees at `/` (English) and `/hi` (Hindi).
 *
 * A server component: all copy is resolved here and handed to the few
 * client pieces as plain strings, so the page ships no translation bundle.
 */
export async function LandingPage({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale });
  const other: Locale = locale === "en" ? "hi" : "en";

  const steps = t.raw("how.steps") as Step[];
  const details = t.raw("features.details") as Detail[];
  const jobs = t.raw("features.print.jobs") as Job[];
  const faqs = t.raw("faq.items") as Faq[];
  const problemLines = t.raw("problem.lines") as string[];
  const layouts = t.raw("features.design.layouts") as string[];

  const jsonLd = landingJsonLd({
    locale,
    description: t("meta.description"),
    tourName: t("tour.title"),
    tourDescription: t("tour.body"),
    faqs,
  });

  return (
    <div className="lp" lang={locale} suppressHydrationWarning>
      <script dangerouslySetInnerHTML={{ __html: MOTION_BOOTSTRAP }} />
      {locale === "hi" && (
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;500;600;700&display=swap"
          precedence="default"
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />

      <SessionRedirect />
      <LandingMotion />
      <LandingNav
        labels={{
          how: t("nav.how"),
          features: t("nav.features"),
          tour: t("nav.tour"),
          faq: t("nav.faq"),
          signIn: t("nav.signIn"),
          startFree: t("nav.startFree"),
          openMenu: t("nav.openMenu"),
          closeMenu: t("nav.closeMenu"),
          switchLanguage: t("nav.switchLanguage"),
          switchLanguageLabel: t("nav.switchLanguageLabel"),
          skip: t("nav.skip"),
        }}
        switchHref={LOCALE_PATH[other]}
        switchLang={other}
      />

      <main id="main" tabIndex={-1} className="outline-none">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="hero-title" className="relative pb-20 pt-[128px] sm:pt-[148px] lg:pb-28">
          <div className="lp-wrap grid items-center gap-14 lg:grid-cols-[1.3fr_1fr] lg:gap-10">
            <div>
              <h1 id="hero-title" data-intro className="lp-display lp-h1 lp-hero-title">
                {t.rich("hero.title", { br: () => <br /> })}
              </h1>
              <p data-intro className="lp-lede mt-7">
                {t("hero.lede")}
              </p>
              <div data-intro className="mt-10 flex flex-wrap items-center gap-3">
                <Link href="/signup" className="lp-btn lp-btn-primary">
                  {t("hero.primary")}
                </Link>
                <a href="#tour" className="lp-btn lp-btn-quiet">
                  {t("hero.secondary")}
                </a>
              </div>
              <p data-intro className="mt-5 text-[14px] text-[var(--lp-faint)]">
                {t("hero.fine")}
              </p>
            </div>
            <div data-intro>
              <HeroStage toast={t("hero.toast")} label={t("hero.stageLabel")} />
            </div>
          </div>
        </section>

        {/* ── The problem ──────────────────────────────────────────────── */}
        <section aria-labelledby="problem-title" className="lp-section lp-rule">
          <div className="lp-wrap">
            <h2 id="problem-title" className="max-w-[30em] text-[18px] text-[var(--lp-muted)] sm:text-[20px]">
              {t("problem.lead")}
            </h2>
            <ul className="mt-10 space-y-4 sm:space-y-6">
              {problemLines.map((line) => (
                <li key={line} className="lp-problem-line lp-display lp-h2 max-w-[18ch]">
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-16 max-w-[26em] border-t border-[var(--lp-line)] pt-8 text-[20px] font-medium leading-snug text-[var(--lp-text)] sm:text-[24px]">
              {t("problem.close")}
            </p>
          </div>
        </section>

        {/* ── How it works ─────────────────────────────────────────────── */}
        <section id="how" aria-labelledby="how-title" className="lp-section lp-band">
          <div className="lp-wrap grid gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
            <div className="lg:sticky lg:top-32 lg:self-start">
              <h2 id="how-title" className="lp-display lp-h2 max-w-[12ch]">
                {t("how.title")}
              </h2>
              <p className="lp-lede mt-6">{t("how.lede")}</p>
            </div>
            <ol className="lp-steps">
              <span aria-hidden="true" className="lp-steps-track" />
              <span aria-hidden="true" className="lp-steps-fill" />
              {steps.map((step, i) => (
                <li
                  key={step.title}
                  className="lp-step relative grid grid-cols-[47px_minmax(0,1fr)] gap-6 pb-14 last:pb-0 sm:gap-8"
                >
                  <span className="lp-step-num relative z-10" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="pt-2">
                    <h3 className="lp-h3">{step.title}</h3>
                    <p className="lp-body mt-3">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────────────── */}
        <section id="features" aria-labelledby="features-title" className="lp-section">
          <div className="lp-wrap">
            <h2 id="features-title" className="lp-display lp-h2 max-w-[14ch]">
              {t("features.title")}
            </h2>

            <div className="mt-20 grid items-center gap-12 lg:mt-28 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
              <div>
                <h3 className="lp-h3">{t("features.design.title")}</h3>
                <p className="lp-body mt-4">{t("features.design.body")}</p>
              </div>
              <DesignTrio layouts={layouts} />
            </div>

            <div className="mt-28 grid items-center gap-12 lg:mt-36 lg:grid-cols-[1.25fr_0.75fr] lg:gap-20">
              <div className="lg:order-2">
                <h3 className="lp-h3">{t("features.board.title")}</h3>
                <p className="lp-body mt-4">{t("features.board.body")}</p>
              </div>
              <div className="lg:order-1">
                <OrdersBoardMini />
              </div>
            </div>

            <div className="mt-28 grid items-center gap-12 lg:mt-36 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
              <div>
                <h3 className="lp-h3">{t("features.print.title")}</h3>
                <p className="lp-body mt-4">{t("features.print.body")}</p>
              </div>
              <TicketRail jobs={jobs} />
            </div>

            <div className="mt-28 lg:mt-40">
              <h3 className="lp-h3 max-w-[22ch]">{t("features.detailsTitle")}</h3>
              <ul className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
                {details.map((d) => (
                  <li key={d.title} className="border-t border-[var(--lp-line)] py-7">
                    <p className="text-[17px] font-semibold leading-snug text-[var(--lp-text)]">{d.title}</p>
                    <p className="mt-2 text-[15.5px] leading-relaxed text-[var(--lp-muted)]">{d.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Printed cards ────────────────────────────────────────────── */}
        <section aria-labelledby="cards-title" className="lp-section lp-band overflow-hidden">
          <div className="lp-wrap grid items-center gap-16 lg:grid-cols-2">
            <div>
              <h2 id="cards-title" className="lp-display lp-h2 max-w-[13ch]">
                {t("cards.title")}
              </h2>
              <p className="lp-lede mt-6">{t("cards.body")}</p>
            </div>
            <TableStand />
          </div>
        </section>

        {/* ── Tour ─────────────────────────────────────────────────────── */}
        <section id="tour" aria-labelledby="tour-title" className="lp-section">
          <div className="lp-wrap">
            <div className="grid gap-6 lg:grid-cols-[1fr_1fr] lg:items-end lg:gap-20">
              <h2 id="tour-title" className="lp-display lp-h2 max-w-[13ch]">
                {t("tour.title")}
              </h2>
              <p className="lp-lede">{t("tour.body")}</p>
            </div>
            <div className="mt-12 lg:mt-16">
              <TourVideo playLabel={t("tour.play")} transcriptLabel={t("tour.transcript")} />
            </div>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────────── */}
        <section id="faq" aria-labelledby="faq-title" className="lp-section lp-rule">
          <div className="lp-wrap grid gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <h2 id="faq-title" className="lp-display lp-h2 max-w-[10ch]">
              {t("faq.title")}
            </h2>
            <div className="border-b border-[var(--lp-line)]">
              {faqs.map((f) => (
                <details key={f.q} className="lp-faq border-t border-[var(--lp-line)]">
                  <summary className="flex items-start justify-between gap-6 py-6 text-[18px] font-semibold leading-snug text-[var(--lp-text)] sm:text-[19px]">
                    {f.q}
                    <svg className="lp-faq-icon mt-1 shrink-0 text-[var(--lp-muted)]" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </summary>
                  <p className="lp-body -mt-1 pb-7 pr-10">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ── Final call ───────────────────────────────────────────────── */}
        <section aria-labelledby="final-title" className="lp-section lp-band">
          <div className="lp-wrap">
            <h2 id="final-title" className="lp-display lp-h1 max-w-[18ch]">
              {t("final.title")}
            </h2>
            <p className="lp-lede mt-7">{t("final.body")}</p>
            <div className="mt-10 flex flex-wrap gap-3">
              <Link href="/signup" className="lp-btn lp-btn-primary">
                {t("final.primary")}
              </Link>
              <Link href="/login" className="lp-btn lp-btn-quiet">
                {t("final.secondary")}
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="lp-rule pb-[calc(40px+env(safe-area-inset-bottom,0px))] pt-16">
        <div className="lp-wrap grid gap-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Link href={LOCALE_PATH[locale]} className="inline-flex items-center gap-2.5" aria-label={BRAND_NAME}>
              <span className="rounded-[8px] ring-1 ring-white/15">
                <Mark size={24} />
              </span>
              <span className="font-display text-[18px] font-semibold tracking-tight">
                menu<span className="text-[var(--lp-faint)]">.irad</span>
              </span>
            </Link>
            <p className="mt-4 max-w-[30ch] text-[14.5px] leading-relaxed text-[var(--lp-muted)]">
              {t("footer.tagline")}
            </p>
            <p className="mt-4 text-[14px] text-[var(--lp-faint)]">
              {t.rich("footer.productOf", {
                link: (chunks) => (
                  <a href={COMPANY_URL} target="_blank" rel="noopener" className="text-[var(--lp-muted)] underline underline-offset-4 hover:text-[var(--lp-text)]">
                    {chunks}
                  </a>
                ),
              })}
            </p>
          </div>

          <FooterColumn
            title={t("footer.product")}
            links={[
              { href: "#how", label: t("nav.how") },
              { href: "#features", label: t("nav.features") },
              { href: "#tour", label: t("nav.tour") },
              { href: "#faq", label: t("nav.faq") },
            ]}
          />
          <FooterColumn
            title={t("footer.account")}
            links={[
              { href: "/signup", label: t("nav.startFree") },
              { href: "/login", label: t("nav.signIn") },
            ]}
          />
          <FooterColumn
            title={t("footer.language")}
            links={[
              { href: LOCALE_PATH.en, label: "English", lang: "en" },
              { href: LOCALE_PATH.hi, label: "हिन्दी", lang: "hi" },
            ]}
          />
        </div>
        <div className="lp-wrap mt-14 text-[13px] text-[var(--lp-faint)]">
          © {new Date().getFullYear()} {BRAND_NAME}. {t("footer.rights")}
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string; lang?: string }[];
}) {
  return (
    <nav aria-label={title}>
      <p className="text-[13px] font-semibold text-[var(--lp-text)]">{title}</p>
      <ul className="mt-4 space-y-2.5 text-[14.5px]">
        {links.map((l) => (
          <li key={l.href}>
            {l.href.startsWith("#") ? (
              <a href={l.href} className="lp-link">
                {l.label}
              </a>
            ) : (
              <Link href={l.href} className="lp-link" lang={l.lang} hrefLang={l.lang}>
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
