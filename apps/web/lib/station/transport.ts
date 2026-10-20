/**
 * A printer, as far as the loop is concerned.
 *
 * Two methods, both async, neither mentioning USB. That is the whole point:
 * `loop.ts` takes one of these and is therefore testable in node, where
 * `navigator` does not exist. The WebUSB implementation below is the only
 * code in this feature that touches the browser's device APIs, and it has
 * no logic in it to get wrong.
 */
export interface PrinterTransport {
  /** device_keys the browser has already granted this origin, no prompt. */
  granted(): Promise<string[]>;
  write(deviceKey: string, bytes: Uint8Array): Promise<void>;
}

type UsbDevice = {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
  configuration?: {
    interfaces: {
      interfaceNumber: number;
      alternate: { endpoints: { direction: string; endpointNumber: number }[] };
    }[];
  };
};

export function deviceKeyOf(d: { vendorId: number; productId: number; serialNumber?: string }): string {
  return `${d.vendorId}:${d.productId}:${d.serialNumber ?? ""}`;
}

/**
 * WebUSB.
 *
 * Chrome and Edge only; Safari and Firefox have neither this nor Web
 * Serial, which the page says plainly rather than failing silently. On
 * Windows a printer installed as a normal Windows printer is claimed by
 * usbprint.sys and cannot be taken over without a one-time WinUSB swap —
 * the chooser simply comes up empty, which the link screen explains.
 */
export function usbTransport(): PrinterTransport {
  const nav = globalThis.navigator as unknown as { usb?: { getDevices(): Promise<UsbDevice[]> } };

  return {
    async granted() {
      if (!nav?.usb) return [];
      return (await nav.usb.getDevices()).map(deviceKeyOf);
    },
    async write(deviceKey, bytes) {
      if (!nav?.usb) throw new Error("This browser has no WebUSB. Use Chrome or Edge.");
      const device = (await nav.usb.getDevices()).find((d) => deviceKeyOf(d) === deviceKey);
      if (!device) throw new Error("Printer not connected");

      await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      const iface = device.configuration!.interfaces[0]!;
      await device.claimInterface(iface.interfaceNumber);
      const endpoint = iface.alternate.endpoints.find((e) => e.direction === "out");
      if (!endpoint) throw new Error("Printer has no output endpoint");
      try {
        await device.transferOut(endpoint.endpointNumber, bytes);
      } finally {
        // Released even on failure: a half-written ticket must not leave
        // the device claimed and unusable until the tab is closed.
        await device.close();
      }
    },
  };
}
