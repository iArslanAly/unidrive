import * as React from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ref, ...props }: React.ComponentPropsWithRef<'input'>) {
  return (
    <input
      ref={ref}
      className={cn('h-11 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-zinc-800/80 dark:bg-zinc-900/60 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-blue-500 dark:focus:ring-blue-500/20', className)}
      {...props}
    />
  )
}
