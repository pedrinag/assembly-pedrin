import "./globals.css";

export const metadata = {
  title: "Transcritor de Vídeos",
  description: "Upload de vídeos e transcrição via AssemblyAI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
