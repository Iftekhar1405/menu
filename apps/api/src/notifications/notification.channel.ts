export type OtpPurposeName = "verify" | "recover";

/** The minimum a channel needs to know about who it is messaging. */
export interface UserContact {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

export interface NotificationChannel {
  readonly name: "whatsapp" | "email";
  /** False when this account has no address for the channel. */
  supports(user: UserContact): boolean;
  sendOtp(user: UserContact, code: string, purpose: OtpPurposeName): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol("NOTIFICATION_CHANNELS");

/** Raised only when every channel the account has failed to deliver. */
export class AllChannelsFailedError extends Error {
  constructor(public readonly failures: { channel: string; reason: string }[]) {
    super(
      `Could not deliver the code on any channel: ${failures
        .map((f) => `${f.channel} (${f.reason})`)
        .join(", ")}`,
    );
    this.name = "AllChannelsFailedError";
  }
}

/** Raised when the account has no email and no phone — impossible per the DB
 * constraint, but a clear failure beats a confusing empty success. */
export class NoChannelsAvailableError extends Error {
  constructor() {
    super("This account has no email address or phone number to send a code to");
    this.name = "NoChannelsAvailableError";
  }
}

export function otpMessageCopy(code: string, purpose: OtpPurposeName): string {
  const reason =
    purpose === "verify" ? "verify your account" : "reset your 6-digit PIN";
  return `${code} is your menu.irad.solutions code to ${reason}. It expires in 10 minutes. Do not share it with anyone.`;
}
