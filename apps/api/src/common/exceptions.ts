import { HttpException, HttpStatus } from "@nestjs/common";

/** 429. Nest ships no built-in for this outside the throttler package. */
export class TooManyRequestsException extends HttpException {
  constructor(message = "Too many requests", public readonly retryAfterSeconds?: number) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
