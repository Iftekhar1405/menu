import { Module } from "@nestjs/common";
import { PinService } from "../auth/pin.service";
import { OtpService } from "./otp.service";

@Module({
  providers: [OtpService, PinService],
  exports: [OtpService],
})
export class OtpModule {}
