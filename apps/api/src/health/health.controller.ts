import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../common/decorators";
import { HealthService } from "./health.service";

/**
 * Public on purpose: a health endpoint behind authentication cannot be read
 * by the uptime monitor that needs it. Nothing here names a tenant, a user or
 * a table — the database check is `select 1` and its error text is redacted —
 * so the most an anonymous caller learns is whether we are up, which they
 * could infer from any other request anyway.
 */
@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Is the process running? Always 200 if this code executes at all, which is
   * the whole point — see HealthService for why this must not consult the
   * database.
   */
  @Public()
  @Get()
  live() {
    return this.health.live();
  }

  /**
   * Can the API serve traffic right now? 503 when it cannot, so a load
   * balancer drains this instance instead of sending it work it will fail.
   *
   * The body is returned either way: an operator reading a 503 wants to know
   * which dependency is down and how long it took to say so, and an empty
   * error page tells them neither.
   */
  @Public()
  @Get("ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.ready();
    res.status(result.status === "ok" ? 200 : 503);
    // Monitors poll this every few seconds and a cached answer is not an
    // answer.
    res.setHeader("Cache-Control", "no-store");
    return result;
  }
}
