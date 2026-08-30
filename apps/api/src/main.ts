import "./config/load-dotenv";
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    // Raw body is needed by the local media upload route, which streams
    // bytes rather than parsing JSON.
    bodyParser: true,
  });

  app.use(cookieParser());

  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  // No global ValidationPipe: every body is validated by a Zod schema from
  // @menu/shared, so the API and the web forms share one source of truth
  // instead of maintaining parallel class-validator DTOs.

  await app.listen(env.API_PORT);

  const logger = new Logger("Bootstrap");
  logger.log(`API listening on http://localhost:${env.API_PORT}`);
  if (env.AUTH_SKIP_VERIFICATION) {
    logger.warn(
      "AUTH_SKIP_VERIFICATION is on — new accounts are auto-verified and OTPs are logged, not sent.",
    );
  }
}

void bootstrap();
