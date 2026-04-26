"use client";

import * as React from "react";

const CurrencyContext = React.createContext<string>("USD");

export function CurrencyProvider({
  currency,
  children,
}: {
  currency: string;
  children: React.ReactNode;
}) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): string {
  return React.useContext(CurrencyContext);
}
