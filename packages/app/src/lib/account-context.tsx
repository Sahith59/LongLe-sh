import { createContext, useContext, type ReactNode } from 'react'

export interface AccountView {
  hosted: boolean
  label?: string
  signOut?: () => void
  exportAccount?: () => void
  deleteAccount?: () => Promise<void>
}

const AccountContext = createContext<AccountView>({ hosted: false })

export function AccountProvider({ value, children }: { value: AccountView; children: ReactNode }) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>
}

export function useAccount(): AccountView {
  return useContext(AccountContext)
}
