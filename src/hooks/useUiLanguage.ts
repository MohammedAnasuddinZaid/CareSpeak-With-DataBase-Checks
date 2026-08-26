"use client";

import { useSyncExternalStore } from "react";
import { subscribeUiLanguage, getUiLanguageSnapshot } from "@/lib/i18n";
import { SupportedLanguage } from "@/types";

/** Currently selected UI/speech language, reactive across the whole app. */
export function useUiLanguage(): SupportedLanguage {
  const lang = useSyncExternalStore(subscribeUiLanguage, getUiLanguageSnapshot, () => "en-US");
  return lang as SupportedLanguage;
}
