import en from "./en";
import hi from "./hi";
import mr from "./mr";
import ta from "./ta";
import te from "./te";
import bn from "./bn";
import gu from "./gu";
import kn from "./kn";
import pa from "./pa";
import type { TranslationDict } from "./en";

export const UI_LANGUAGES = [
  { code: "en", native: "English" },
  { code: "hi", native: "हिन्दी" },
  { code: "mr", native: "मराठी" },
  { code: "ta", native: "தமிழ்" },
  { code: "te", native: "తెలుగు" },
  { code: "bn", native: "বাংলা" },
  { code: "gu", native: "ગુજરાતી" },
  { code: "kn", native: "ಕನ್ನಡ" },
  { code: "pa", native: "ਪੰਜਾਬੀ" },
] as const;

export type UiLangCode = (typeof UI_LANGUAGES)[number]["code"];

export const DICTS: Record<UiLangCode, TranslationDict> = { en, hi, mr, ta, te, bn, gu, kn, pa };

export type { TranslationDict };
