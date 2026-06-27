import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Tandem',
  description: 'Multiplayer coordination for AI coding sessions',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
