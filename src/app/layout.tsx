import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ahivim Budget Management",
  description:
    "Authorization, utilization and payroll import tracking for individual service programs.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
