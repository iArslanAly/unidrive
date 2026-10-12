import type { ReactNode } from 'react'
import { useOutletContext } from 'react-router-dom'

/**
 * Context exposed by DriveLayout through react-router's <Outlet context>.
 * Kept in a dedicated module (not DriveLayout.tsx) so Vite Fast Refresh can
 * update the layout component without invalidating this hook — mixing a
 * non-component export into a component file breaks HMR and remounts state.
 */
export type DriveLayoutContext = {
  setHeaderActions: (actions: ReactNode) => void
}

export function useDriveLayoutActions() {
  return useOutletContext<DriveLayoutContext>()
}
