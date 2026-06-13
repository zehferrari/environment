export const MANUAL_IMAGE_THEME = "Manually Uploaded";

export const AGENT_PROFILE_IMAGE_THEMES = [
  MANUAL_IMAGE_THEME,
  "Famous historical strategist",
  "Renaissance polymath inventor",
  "Ancient Egyptian oracle",
  "Greek mythic titan",
  "Norse saga shieldbearer",
  "Samurai cybernetic cartographer",
  "Victorian occult detective",
  "Golden-age astronaut explorer",
  "Friendly alien botanist",
  "Deep-sea bioluminescent navigator",
  "Jungle jaguar guardian",
  "Arctic fox trickster",
  "Phoenix keeper from a lost empire",
  "Pop-culture space outlaw",
  "Comic-book solar guardian",
  "Noir jazz club mastermind",
  "Art deco aviation pioneer",
  "Retro-futurist lab assistant",
  "Cyberpunk street medic",
  "Brazilian modernist muse",
  "Capoeira rooftop hero",
  "Clockwork librarian automaton",
  "Desert nomad engineer",
  "Mushroom forest alchemist",
  "Interdimensional diplomat",
] as const;

export function normalizeProfileImageTheme(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || MANUAL_IMAGE_THEME;
}

export function isManualProfileImageTheme(value: unknown): boolean {
  return normalizeProfileImageTheme(value) === MANUAL_IMAGE_THEME;
}
