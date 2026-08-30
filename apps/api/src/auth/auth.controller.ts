import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  pinResetSchema,
  signupSchema,
  type LoginInput,
  type OtpRequestInput,
  type OtpVerifyInput,
  type PinResetInput,
  type SignupInput,
} from "@menu/shared";
import { CurrentUser, Public } from "../common/decorators";
import { ZodBody } from "../common/zod.pipe";
import { loadEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";
import type { RequestUser } from "./jwt.strategy";
import type { IssuedTokens } from "./token.service";

const REFRESH_COOKIE = "menu_rt";

@Controller("auth")
export class AuthController {
  private readonly env = loadEnv();

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * httpOnly so script cannot read it, secure in production, and Lax rather
   * than None because the web app and API are same-site in deployment. Path
   * is scoped to /auth so it is not attached to every ordinary API call.
   */
  private setRefreshCookie(res: Response, tokens: IssuedTokens): void {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: this.env.NODE_ENV === "production",
      sameSite: "lax",
      expires: tokens.refreshExpiresAt,
      path: "/auth",
    });
  }

  @Public()
  @Post("signup")
  async signup(
    @Body(new ZodBody(signupSchema)) body: SignupInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.signup(body);
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @HttpCode(200)
  @Post("login")
  async login(
    @Body(new ZodBody(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body);
    this.setRefreshCookie(res, result);
    return { accessToken: result.accessToken, user: result.user };
  }

  @Public()
  @HttpCode(200)
  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const presented = req.cookies?.[REFRESH_COOKIE];
    if (!presented) throw new UnauthorizedException("No session to refresh");

    const tokens = await this.auth.refresh(presented);
    this.setRefreshCookie(res, tokens);
    return { accessToken: tokens.accessToken };
  }

  @Public()
  @HttpCode(204)
  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { path: "/auth" });
  }

  @Public()
  @HttpCode(200)
  @Post("otp/request")
  async requestOtp(@Body(new ZodBody(otpRequestSchema)) body: OtpRequestInput) {
    return this.auth.requestOtp(body);
  }

  @Public()
  @HttpCode(200)
  @Post("otp/verify")
  async verifyOtp(@Body(new ZodBody(otpVerifySchema)) body: OtpVerifyInput) {
    const ok = await this.auth.verifyOtp(
      body.identifier,
      body.purpose,
      body.code,
      body.country ?? "IN",
    );
    if (!ok) throw new UnauthorizedException("That code is not correct");
    return { verified: true };
  }

  @Public()
  @HttpCode(204)
  @Post("pin/reset")
  async resetPin(@Body(new ZodBody(pinResetSchema)) body: PinResetInput) {
    await this.auth.resetPin(body);
  }

  /** Who am I — used by the web app to hydrate the session on load. */
  @Get("me")
  async me(@CurrentUser() user: RequestUser) {
    const record = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, fullName: true, email: true, phone: true, role: true, verifiedAt: true },
    });
    if (!record) throw new UnauthorizedException();
    return {
      id: record.id,
      fullName: record.fullName,
      email: record.email,
      phone: record.phone,
      role: record.role,
      verified: record.verifiedAt !== null,
    };
  }
}
