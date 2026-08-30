import { MenuView } from "@/components/templates";
import { PhoneFrame } from "@/components/phone-frame";
import { sampleMenu } from "@/lib/sample-menu";
import { Wordmark } from "@/components/brand";

/**
 * The signup screen shows the thing being sold, at the size it will be read.
 * A screenshot of a dashboard would be selling the tool; this sells the
 * outcome — what a diner sees after scanning the card on their table.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-9">
            <Wordmark full size={21} />
          </div>
          {children}
        </div>
      </main>

      <aside className="relative hidden items-center justify-center overflow-hidden bg-[#101014] lg:flex">
        <div className="relative z-10 flex flex-col items-center px-10">
          <PhoneFrame scale={0.82}>
            <MenuView menu={sampleMenu()} compactChrome />
          </PhoneFrame>
          <p className="mt-8 max-w-[300px] text-center text-[14px] leading-relaxed text-white/55">
            This is what someone sees when they scan the code on their table.
          </p>
        </div>
        <div
          aria-hidden="true"
          className="absolute -bottom-32 left-1/2 h-[420px] w-[420px] -translate-x-1/2 rounded-full bg-white/[0.04] blur-3xl"
        />
      </aside>
    </div>
  );
}
