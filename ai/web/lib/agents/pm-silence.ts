export const PM_SILENT_REPLY_TOKEN = "PM_SILENT_NO_CONTRIBUTION";

export function isSilentPmReplyText(value: string | null | undefined): boolean {
  return value?.trim().toUpperCase() === PM_SILENT_REPLY_TOKEN;
}
