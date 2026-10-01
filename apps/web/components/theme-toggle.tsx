"use client";

import { useTheme, type DarkMode } from "@/components/theme-provider";
import { cx } from "@/components/ui";

/**
 * A compact control for switching between light, system, and dark modes.
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-faint uppercase tracking-widest">Dark mode</span>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-raised p-0.5">
          <ModeButton id="theme-light" value="light" current={mode} onSelect={setMode} label="Light" icon={<SunIcon />} />
          <ModeButton id="theme-system" value="system" current={mode} onSelect={setMode} label="System" icon={<SystemIcon />} />
          <ModeButton id="theme-dark" value="dark" current={mode} onSelect={setMode} label="Dark" icon={<MoonIcon />} />
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  id,
  value,
  current,
  onSelect,
  label,
  icon,
}: {
  id: string;
  value: DarkMode;
  current: DarkMode;
  onSelect: (v: DarkMode) => void;
  label: string;
  icon: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      id={id}
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={() => onSelect(value)}
      title={label}
      className={cx(
        "spring flex h-7 w-7 items-center justify-center rounded-lg text-[13px]",
        active
          ? "bg-surface text-ink shadow-card"
          : "text-faint hover:text-muted",
      )}
    >
      {icon}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}
