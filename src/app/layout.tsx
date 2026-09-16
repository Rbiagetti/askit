import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Second Brain AI",
  description: "Una memoria esterna intelligente, a comando vocale",
};

// Non è un sito di contenuti da ingrandire — è un'app. Il pizzicare per
// zoomare (o lo zoom automatico che iOS attiva da solo quando il focus va su
// un input con font sotto i 16px) lasciava la pagina bloccata ingrandita
// dopo aver chiuso la modifica, causa diretta di una cancellazione per
// sbaglio segnalata dall'utente. Bloccato qui; l'altra metà del fix è avere
// font >= 16px su input/textarea, così iOS non tenta lo zoom nemmeno prima
// che questo blocco intervenga.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" className={`${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
