import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "SILENCIO ® VISUAL LANGUAGES",
  description:
    "We craft unique, innovative and memorable digital brand experiences that leave a lasting impact throught design and interactivity.",
  alternates: {
    canonical: "https://silencio.es/",
  },
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    other: [
      {
        rel: "mask-icon",
        url: "/safari-pinned-tab.svg",
        color: "#dbdad9",
      },
    ],
  },
  openGraph: {
    locale: "en_GB",
    type: "website",
    title: "SILENCIO - DIGITAL PRODUCTS FOR CONTEMPORARY BRANDS",
    description:
      "Silencio is a design studio focused on visual languages for daring brands outside the norm.",
    url: "https://silencio.es/",
  },
  other: {
    google: "notranslate",
    "msapplication-TileColor": "#dbdad9",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#dbdad9",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-Q9WNHZP2XG"
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-Q9WNHZP2XG');
          `}
        </Script>
        {children}
      </body>
    </html>
  );
}
