'use client';

import Link from 'next/link';
import { APP_NAME } from '@/config/brand';
import BrandMark from '@/components/BrandMark';

export default function BrandHeader() {
  return (
    <>
      <header className="fixed top-0 right-0 left-[var(--app-sidebar-width)] z-30 h-14 bg-white border-b border-gray-200 flex items-center px-4 min-w-0 transition-[left] duration-300">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity flex-shrink-0">
          <BrandMark />
          <span className="font-bold text-sm text-gray-800 tracking-tight">
            {APP_NAME}
          </span>
        </Link>
      </header>
      <div className="h-14 flex-shrink-0" />
    </>
  );
}
