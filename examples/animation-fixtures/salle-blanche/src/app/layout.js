import { Host_Grotesk, DM_Mono } from "next/font/google";

import ClientLayout from "@/client-layout";

import "./globals.css";

const hostGrotesk = Host_Grotesk({
  subsets: ["latin"],
  variable: "--font-host-grotesk",
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-dm-mono",
});

export const metadata = {
  title: "Salle Blanche | Codegrid",
  description: "MWT by Codegrid | FEB 2026",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${hostGrotesk.variable} ${dmMono.variable}`}>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
