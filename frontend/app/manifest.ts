import type { MetadataRoute } from "next";

/* Installed to the home screen, the app opens in portrait. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Handyman",
    short_name: "Handyman",
    description: "Point at what's broken, describe it, follow the highlighted fix.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#24292d",
    theme_color: "#24292d",
  };
}
