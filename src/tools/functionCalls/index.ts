/**
 * Function Call Tools Export
 * Centralizes all function call tool exports
 *
 * ⚠️ DEPRECATION NOTICE:
 * This file is NO LONGER REQUIRED for tool registration!
 * Tools are now automatically discovered and registered by toolInitializer.ts
 *
 * This file is maintained for:
 * - Backwards compatibility with existing imports
 * - Manual imports in tests or external code
 * - Documentation reference
 *
 * TO ADD A NEW TOOL:
 * Simply create a .ts file in this directory that exports a class extending BaseTool.
 * It will be automatically discovered and registered - no need to update this file!
 *
 * MCP tools are now handled by Google's official mcpToTool() integration
 * in GoogleProvider - no manual wrappers needed!
 */

export { StickerTool } from "./stickerTool";
export { MemoryTool } from "./memoryTool";
export { YouTubeVideoTool } from "./youTubeVideoTool";
export { PeekProfilePictureTool } from "./peekProfilePictureTool";
export { PinMessageTool } from "./pinMessageTool";
export { ReminderTool } from "./reminderTool";
export { ReviewCapabilitiesTool } from "./reviewCapabilities";

// Re-export common types for convenience
export type { Tool, ToolContext, ToolResult } from "../../types/tool/interfaces";
