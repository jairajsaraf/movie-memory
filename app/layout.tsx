import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Movie Memory",
  description: "A fun fact about your favorite movie.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
