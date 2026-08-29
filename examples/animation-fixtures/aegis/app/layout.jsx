import "./site.css";

export const metadata = {
  title: "AEGIS - Experiment",
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
