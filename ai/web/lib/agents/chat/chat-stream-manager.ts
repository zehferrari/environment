// Shared client-side PM chat stream manager facade.
//
// The implementation lives with the PersistentPmStreamProvider because it owns
// the React external store and browser connection lifecycle. This module gives
// UI consumers and tests a stable ChatStreamManager import while Phase 3 starts
// with direct-chat wiring first.

export {
  ChatStreamManager,
  chatStreamRoomId,
  type ChatStreamTarget,
} from "@/components/persistent-pm-stream-provider";
