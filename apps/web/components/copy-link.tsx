"use client";

import { useState } from "react";
import { Button } from "./ui";

/** Copy confirmation is on the button itself — a toast for this is overkill. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <code className="truncate rounded-lg bg-raised px-2.5 py-2 text-[13px] text-muted">
        {url.replace(/^https?:\/\//, "")}
      </code>
      <Button
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
