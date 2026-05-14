import type { Metadata } from "next";
import { JetBrains_Mono, Orbitron, Rajdhani } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// Three families per the Home Apps design system:
//   Orbitron        → display headers (h1-h3), HUD callouts
//   Rajdhani        → body / UI text, slightly condensed
//   JetBrains Mono  → terminals, metrics, money/dates (the "tabular" class)
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

const display = Orbitron({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-display",
  display: "swap",
});

const ui = Rajdhani({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FINANCE_OS",
  description: "Personal budget tracker",
  manifest: "/manifest.json",
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${mono.variable} ${display.variable} ${ui.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#0ff" />
        <link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icons/icon.svg" />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeProvider>{children}</ThemeProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `if("serviceWorker"in navigator){navigator.serviceWorker.register("/sw.js")}`,
          }}
        />
      </body>
    </html>
  );
}
