export type AppRole = "member" | "officer" | "admin";
export type MsgRole = "user" | "assistant" | "system";
export type InputMode = "text" | "voice";

export type KbCategory =
  | "cooperative_law" | "bylaws" | "ministry_scheme"
  | "pacs_service" | "pmfby" | "financial_literacy" | "grievance";

export type GrievanceStatus = "open" | "in_review" | "escalated" | "resolved" | "closed";

export interface Profile {
  id: string;
  full_name: string | null;
  phone: string | null;
  preferred_lang: string;
  preferred_model: string;
  state: string | null;
  district: string | null;
  pacs_name: string | null;
  role: AppRole;
}

export interface Citation {
  title: string;
  source_url: string | null;
  similarity: number;
  // Blockchain-anchoring fields (see BLOCKCHAIN-PLAN.md). `anchored` means
  // only "a chain_tx_hash exists on this document's row" — it is NOT a
  // live integrity check. A live check is a separate verify-document call
  // keyed by document_id; see lib/verify-document.ts.
  anchored?: boolean;
  document_id?: string | null;
  chain_tx_hash?: string | null;
  chain_network?: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MsgRole;
  content: string;
  lang: string;
  mode: InputMode;
  citations: Citation[];
  created_at: string;
}

export interface Conversation {
  id: string; title: string; lang: string; updated_at: string;
}

export interface Scheme {
  id: string; code: string; name: string; summary: string;
  benefits: string | null; eligibility: string | null;
  apply_url: string | null; category: KbCategory;
}

export interface Grievance {
  id: string; ticket_no: string; subject: string; description: string;
  status: GrievanceStatus; created_at: string;
}

export const LANGUAGES = [
  { code: "en", label: "English",  native: "English" },
  { code: "hi", label: "Hindi",    native: "हिन्दी" },
  { code: "mr", label: "Marathi",  native: "मराठी" },
  { code: "ta", label: "Tamil",    native: "தமிழ்" },
  { code: "te", label: "Telugu",   native: "తెలుగు" },
  { code: "bn", label: "Bengali",  native: "বাংলা" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી" },
  { code: "kn", label: "Kannada",  native: "ಕನ್ನಡ" },
  { code: "pa", label: "Punjabi",  native: "ਪੰਜਾਬੀ" },
] as const;

// Every Gemini text-chat model available on the free tier as of 2026-08, confirmed
// live against this project's key. Each model has its OWN separate daily quota, so
// letting a user switch is a real fix when one gets rate-limited — not just cosmetic.
// "stable" models are pinned versions; "latest"/"preview" ones can change under you.
export const GEMINI_MODELS = [
  { id: "gemini-3.1-flash-lite",       label: "Gemini 3.1 Flash Lite",        tier: "stable",  recommended: true },
  { id: "gemini-2.5-flash-lite",       label: "Gemini 2.5 Flash Lite",        tier: "stable" },
  { id: "gemini-3.5-flash-lite",       label: "Gemini 3.5 Flash Lite",        tier: "stable" },
  { id: "gemini-3.5-flash",            label: "Gemini 3.5 Flash",             tier: "stable" },
  { id: "gemini-2.5-flash",            label: "Gemini 2.5 Flash",             tier: "stable" },
  { id: "gemini-3.6-flash",            label: "Gemini 3.6 Flash",             tier: "stable" },
  { id: "gemini-3.7-flash",            label: "Gemini 3.7 Flash",             tier: "stable" },
  { id: "gemini-2.5-pro",              label: "Gemini 2.5 Pro",               tier: "stable" },
  { id: "gemini-flash-lite-latest",    label: "Gemini Flash Lite (latest)",   tier: "latest" },
  { id: "gemini-flash-latest",         label: "Gemini Flash (latest)",        tier: "latest" },
  { id: "gemini-pro-latest",           label: "Gemini Pro (latest)",          tier: "latest" },
  { id: "gemini-3-flash-preview",      label: "Gemini 3 Flash (preview)",     tier: "preview" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite (preview)", tier: "preview" },
  { id: "gemini-3.1-pro-preview",      label: "Gemini 3.1 Pro (preview)",     tier: "preview" },
] as const;
