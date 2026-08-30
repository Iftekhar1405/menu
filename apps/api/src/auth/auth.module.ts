import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { OtpModule } from "../otp/otp.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { PinService } from "./pin.service";
import { TokenService } from "./token.service";

@Module({
  imports: [PassportModule, JwtModule.register({}), OtpModule],
  controllers: [AuthController],
  providers: [AuthService, PinService, TokenService, JwtStrategy],
  exports: [PinService, TokenService],
})
export class AuthModule {}
