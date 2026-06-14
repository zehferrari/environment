export const PROFILE_IMAGE_CUSTOMIZATION_MODES = [
  "Random",
  "Custom",
] as const;

export const PROFILE_IMAGE_GENDERS = [
  "Random",
  "Feminine",
  "Masculine",
  "Androgynous",
] as const;

export const PROFILE_IMAGE_AGE_GROUPS = [
  "Random",
  "Young adult",
  "Adult",
  "Middle-aged",
  "Senior",
] as const;

export const PROFILE_IMAGE_ETHNICITIES = [
  "Random",
  "African",
  "East Asian",
  "South Asian",
  "Southeast Asian",
  "Middle Eastern",
  "Latine",
  "Indigenous",
  "European",
  "Mixed ethnicity",
] as const;

export const DEFAULT_PROFILE_IMAGE_GENDER = "Random";
export const DEFAULT_PROFILE_IMAGE_AGE_GROUP = "Random";
export const DEFAULT_PROFILE_IMAGE_ETHNICITY = "Random";
export const DEFAULT_PROFILE_IMAGE_CUSTOMIZATION_MODE = "Random";

export const DEFAULT_PROFILE_IMAGE_PROMPT = [
  "professional corporate photo ID headshot of a fictional AI agent, centered face, looking directly at camera,",
  "neutral confident expression, realistic human portrait, shoulders visible, clean light gray studio background,",
  "soft even studio lighting, sharp facial details, natural skin texture, realistic eyes, symmetrical framing,",
  "passport photo composition, high-end corporate badge photo, 85mm lens, f/5.6, photorealistic, high quality",
].join(" ");

export function normalizeProfileImageCustomizationMode(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "Custom" ? "Custom" : DEFAULT_PROFILE_IMAGE_CUSTOMIZATION_MODE;
}

export function normalizeProfileImageGender(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return DEFAULT_PROFILE_IMAGE_GENDER;
  return PROFILE_IMAGE_GENDERS.some((option) => option.toLowerCase() === text.toLowerCase())
    ? PROFILE_IMAGE_GENDERS.find((option) => option.toLowerCase() === text.toLowerCase())!
    : DEFAULT_PROFILE_IMAGE_GENDER;
}

export function normalizeProfileImageAgeGroup(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return DEFAULT_PROFILE_IMAGE_AGE_GROUP;
  return PROFILE_IMAGE_AGE_GROUPS.some((option) => option.toLowerCase() === text.toLowerCase())
    ? PROFILE_IMAGE_AGE_GROUPS.find((option) => option.toLowerCase() === text.toLowerCase())!
    : DEFAULT_PROFILE_IMAGE_AGE_GROUP;
}

export function normalizeProfileImageEthnicity(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return DEFAULT_PROFILE_IMAGE_ETHNICITY;
  return PROFILE_IMAGE_ETHNICITIES.some((option) => option.toLowerCase() === text.toLowerCase())
    ? PROFILE_IMAGE_ETHNICITIES.find((option) => option.toLowerCase() === text.toLowerCase())!
    : DEFAULT_PROFILE_IMAGE_ETHNICITY;
}

export function normalizeProfileImagePrompt(value: unknown, fallback = DEFAULT_PROFILE_IMAGE_PROMPT): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

export function normalizeProfileImageContextText(value: unknown, maxLength = 120): string {
  const limit = Math.max(1, Math.floor(maxLength));
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
