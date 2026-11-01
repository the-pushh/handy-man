import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import TraceDrawer from "./components/TraceDrawer";

export const metadata: Metadata = {
  title: "HandyMan — point, describe, repair",
  description:
    "Voice-first repair assistant: point at the appliance, describe the issue, follow the highlighted fix.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {/* The app is built for phones. On a wider screen it runs inside a
            phone-shaped frame, so it looks the same everywhere. */}
        <div className="phone mat">
          {children}
          <TraceDrawer />
        </div>
      </body>
    </html>
  );
}
