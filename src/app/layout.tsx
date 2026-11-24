import type { Metadata, Viewport } from "next";
import "./globals.css";

const BP = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "ANIME STUDIO — AI Anime Video Editor",
  description:
    "Professional browser-based anime video editing: nonlinear timeline, keyframes, real effects, AI editing assistant, smooth motion, detail restore, and real export. Optimized for iPhone Safari.",
  keywords: ["anime editor", "AMV", "video editing", "AI editor", "velocity edit", "smooth motion", "keyframes"],
  applicationName: "ANIME STUDIO",
  manifest: `${BP}/manifest.webmanifest`,
  icons: {
    icon: [
      { url: `${BP}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
      { url: `${BP}/icons/icon-512.png`, sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: `${BP}/icons/apple-touch-icon.png`, sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ANIME STUDIO",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#09090b",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-zinc-950 text-zinc-200 font-sans overscroll-none">
        {children}
      </body>
    </html>
  );
}
