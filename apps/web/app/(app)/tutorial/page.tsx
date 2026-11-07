"use client";

import { TourVideo } from "@/components/tour-video";

/**
 * The product tour, inside the dashboard, for owners and admins.
 *
 * The same file the landing page plays: an owner who watched it before
 * signing up can find it again here when they come to set up printing or
 * add their kitchen staff. Kitchen accounts don't get this page; their
 * screens are already the whole of their job.
 */
export default function TutorialPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-12">
      <header className="mb-8">
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[30px]">Tutorial</h1>
        <p className="mt-1 text-[14.5px] text-muted">
          A full service in four minutes: building the menu, a table ordering, the kitchen ticket printing
          and the bill at the end. Narrated in Hinglish.
        </p>
      </header>
      <TourVideo tone="app" playLabel="Play the tour" transcriptLabel="Read the transcript" />
    </div>
  );
}
