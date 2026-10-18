"use client"

import { createContext, useContext } from "react"
import type { Dataset } from "@workspace/domain/datasets"

const LoadedDatasets = createContext<readonly Dataset[]>([])

export function LoadedDatasetsProvider({
  datasets,
  children,
}: {
  datasets: readonly Dataset[]
  children?: React.ReactNode
}) {
  return <LoadedDatasets value={datasets}>{children}</LoadedDatasets>
}

export function useLoadedDatasets() {
  return useContext(LoadedDatasets)
}
