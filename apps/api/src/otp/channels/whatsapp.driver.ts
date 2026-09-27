import { Injectable, Logger } from "@nestjs/common";
import type { Env } from "../../config/env";
import {
  NotificationChannel,
  OtpPurposeName,
  UserContact,
} from "./notification.channel";

/**
 * Meta WhatsApp Business Cloud API, spoken to directly — no reseller.
 *
 * OTPs must go out on an approved template in the AUTHENTICATION category;
 * Meta will not deliver a free-form message to someone who has not messaged
 * the business first. The template is expected to have one body parameter
 * (the code) and a copy-code button, which is the standard authentication
 * template shape.
 *
 * Inert until WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN are set;
 * the module wires the console driver instead in that case.
 */
@Injectable()
export class WhatsAppDriver implements NotificationChannel {
  readonly name = "whatsapp" as const;
  private readonly logger = new Logger(WhatsAppDriver.name);

  constructor(private readonly env: Env) {}

  supports(user: UserContact): boolean {
    return Boolean(user.phone);
  }

  async sendOtp(user: UserContact, code: string, _purpose: OtpPurposeName): Promise<void> {
    if (!user.phone) throw new Error("No phone number on this account");

    // Meta wants the number without a leading '+'.
    const to = user.phone.replace(/^\+/, "");
    const url = `https://graph.facebook.com/v21.0/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: this.env.WHATSAPP_OTP_TEMPLATE,
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: code }],
          },
        ],
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "<unreadable>");
      this.logger.error(`WhatsApp send failed (${res.status}): ${detail}`);
      throw new Error(`WhatsApp responded ${res.status}`);
    }
  }
}
