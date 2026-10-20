import { describe, expect, it } from "vitest";
import { deviceKeyOf, serialKeyOf } from "./transport";

describe("device keys", () => {
  it("derives a USB key the link screen and granted() both produce", () => {
    expect(deviceKeyOf({ vendorId: 1208, productId: 514, serialNumber: "X1" })).toBe(
      "1208:514:X1",
    );
  });

  it("keeps a USB key stable when the printer reports no serial number", () => {
    // Common on cheap thermal printers. Both sides must collapse the
    // missing field the same way or the key never matches again.
    expect(deviceKeyOf({ vendorId: 1208, productId: 514 })).toBe("1208:514:");
  });

  it("namespaces serial keys so they cannot collide with USB ones", () => {
    // Without the prefix, a serial port and a USB device sharing ids would
    // produce the same key and transportFor would route to the wrong API.
    expect(serialKeyOf({ usbVendorId: 1208, usbProductId: 514 })).toBe("serial:1208:514");
  });

  it("keeps a serial key stable when getInfo reports no USB ids", () => {
    expect(serialKeyOf({})).toBe("serial::");
  });
});
