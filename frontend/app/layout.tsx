import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "HandyMan — point, describe, repair",
  description:
    "Voice-first repair assistant: point at the appliance, describe the issue, follow the highlighted fix.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
