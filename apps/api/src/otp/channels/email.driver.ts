import { Injectable, Logger } from "@nestjs/common";
import type { Env } from "../../config/env";
import {
  NotificationChannel,
  OtpPurposeName,
  UserContact,
  otpMessageCopy,
} from "./notification.channel";

/**
 * Resend. Inert until RESEND_API_KEY is set, at which point the module wires
 * it in place of the console driver for the email channel.
 */
@Injectable()
export class EmailDriver implements NotificationChannel {
  readonly name = "email" as const;
  private readonly logger = new Logger(EmailDriver.name);

  constructor(private readonly env: Env) {}

  supports(user: UserContact): boolean {
    return Boolean(user.email);
  }

  async sendOtp(user: UserContact, code: string, purpose: OtpPurposeName): Promise<void> {
    if (!user.email) throw new Error("No email address on this account");

    const subject =
      purpose === "verify"
        ? `${code} — verify your menu.irad.solutions account`
        : `${code} — reset your PIN`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.env.RESEND_FROM,
        to: [user.email],
        subject,
        text: otpMessageCopy(code, purpose),
        html: renderOtpEmail(user.fullName, code, purpose),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "<unreadable>");
      this.logger.error(`Resend send failed (${res.status}): ${detail}`);
      throw new Error(`Resend responded ${res.status}`);
    }
  }
}

function renderOtpEmail(name: string, code: string, purpose: OtpPurposeName): string {
  const reason =
    purpose === "verify" ? "verify your account" : "reset your 6-digit PIN";
  return `<!doctype html>
<html><body style="margin:0;padding:32px;background:#FAFAF8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1C1C1E">
  <div style="max-width:440px;margin:0 auto">
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.5">Use this code to ${reason}.</p>
    <p style="margin:0 0 24px;font-size:34px;letter-spacing:8px;font-weight:600;font-variant-numeric:tabular-nums">${code}</p>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#6B6B70">It expires in 10 minutes. If you did not ask for it, you can ignore this email.</p>
    <p style="margin:32px 0 0;font-size:12px;color:#9A9AA0">menu.irad.solutions</p>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    };
    return map[c] ?? c;
  });
}
