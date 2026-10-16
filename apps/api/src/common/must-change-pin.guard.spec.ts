import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { MustChangePinGuard } from "./must-change-pin.guard";

function ctx(user: unknown, path: string) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, path }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as never;
}

describe("MustChangePinGuard", () => {
  const guard = new MustChangePinGuard();

  it("lets an ordinary user through", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: false }, "/orders"))).toBe(true);
  });

  // Review Focus 4: the UI gate is cosmetic; the API must refuse too.
  it("refuses every other route while a PIN change is owed", () => {
    expect(() => guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/businesses/mine")))
      .toThrow(ForbiddenException);
  });

  it("allows the change-PIN route itself", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/auth/pin/change"))).toBe(true);
  });

  it("allows /auth/me, so the app can learn why it is blocked", () => {
    expect(guard.canActivate(ctx({ id: "u", mustChangePin: true }, "/auth/me"))).toBe(true);
  });

  it("ignores unauthenticated requests", () => {
    expect(guard.canActivate(ctx(undefined, "/public/menu"))).toBe(true);
  });
});
