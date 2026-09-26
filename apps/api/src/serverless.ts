import "./config/load-dotenv";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import type { Express, Request, Response } from "express";
import { AppModule } from "./app.module";
import { corsOrigins, loadEnv } from "./config/env";

/**
 * Serverless bootstrap for Vercel. The counterpart to main.ts, which owns the
 * long-lived local process; this one hands an Express instance back to the
 * platform instead of binding a port.
 *
 * It lives in src/ so `nest build` (tsc) compiles it with
 * emitDecoratorMetadata — the metadata NestJS DI reads and that Vercel's
 * esbuild bundler would otherwise strip. /api/index.ts at the repo root
 * delegates to the compiled output, never to this source file.
 */
async function bootstrap(): Promise<Express> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  app.use(cookieParser());
  app.enableCors({ origin: corsOrigins(env), credentials: true });

  await app.init();
  return app.getHttpAdapter().getInstance() as Express;
}

// Cached so concurrent requests on a cold instance share one init rather than
// each paying for their own Nest container.
let cachedApp: Promise<Express> | undefined;

export default async function handler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    cachedApp ??= bootstrap();
    const app = await cachedApp;
    app(req, res);
  } catch (err) {
    // A failed bootstrap must not stay in the cache, or every later request on
    // this warm instance fails the same way with no chance to recover. Clear it
    // so the next invocation retries, and answer with a handled 500 rather than
    // Vercel's opaque FUNCTION_INVOCATION_FAILED.
    cachedApp = undefined;
    console.error("[serverless] bootstrap failed:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Server initialization failed" }));
  }
}
