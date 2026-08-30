import { BadRequestException, PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Validates a body against a schema from @menu/shared, so the API and the web
 * forms enforce exactly the same rules. Field-level messages are returned in
 * a shape the client can map straight onto inputs.
 */
export class ZodBody<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const fieldErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_";
      fieldErrors[key] ??= issue.message;
    }

    throw new BadRequestException({
      statusCode: 400,
      message: result.error.issues[0]?.message ?? "Invalid request",
      fieldErrors,
    });
  }
}
