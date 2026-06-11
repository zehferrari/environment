export interface DirectChatCursor {
  createdAt: Date;
  id: string;
}

export function parseDirectChatCursor(params: URLSearchParams): DirectChatCursor | null {
  const afterParam = params.get("after");
  const afterId = params.get("afterId")?.trim() ?? "";
  if (!afterParam || !afterId) return null;

  const afterDate = new Date(afterParam);
  if (Number.isNaN(afterDate.getTime())) return null;

  return { createdAt: afterDate, id: afterId };
}

export function directChatCursorWhere(cursor: DirectChatCursor | null) {
  if (!cursor) return {};

  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}
