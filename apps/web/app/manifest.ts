import type { MetadataRoute } from "next";

/**
 * Exists mainly for the diner side. A menu that has been added to a home
 * screen should open like an app rather than a browser tab with our chrome
 * around it, and staff often leave the orders board pinned during service.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "menu.irad.solutions",
    short_name: "menu.irad",
    description:
      "Build a menu, print a QR code, and let people order from the table.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f7f8",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
