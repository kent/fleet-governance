import type { ReactNode } from "react";

export const metadata = {
  title: "Fleet Governance Runner",
  description: "Configure and start a Fleet Governance experiment run.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
