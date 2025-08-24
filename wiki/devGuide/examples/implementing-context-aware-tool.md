# Context-Aware Tool Implementation

This tutorial demonstrates how to implement **context-aware tools** that can dynamically show/hide themselves based on runtime conditions. We'll build a comprehensive example that showcases all the advanced patterns available in TomoriBot's context-aware system.

## Overview

We'll create an **Admin Tool** that demonstrates:
- User permission-based availability
- Time-based restrictions  
- Resource usage awareness
- Operational mode sensitivity
- Rate limiting
- Feature flag integration

## Step 1: Understanding Context-Aware Architecture

### Basic vs Context-Aware Availability

```typescript
interface Tool {
  // Required: Static provider compatibility
  isAvailableFor(provider: string): boolean;
  
  // Optional: Dynamic runtime conditions
  isAvailableForContext?(provider: string, context?: ToolContext): boolean;
}
```

**Pattern**: Always call the base method first, then add contextual logic.

### ToolContext Structure

```typescript
interface ToolContext {
  // Discord context
  channel: BaseGuildTextChannel;
  client: Client;
  message?: Message;
  
  // Tomori context  
  tomoriState: TomoriState;
  locale: string;
  
  // Provider context
  provider: string;
  
  // Streaming context for advanced features
  streamContext?: StreamingContext;
}
```

## Step 2: Implement Advanced Admin Tool

**File**: `src/tools/functionCalls/advancedAdminTool.ts`

```typescript
/**
 * Advanced Admin Tool - Context-Aware Implementation
 * Demonstrates all patterns for dynamic tool availability
 */

import { BaseTool } from "../../types/tool/interfaces";
import type {
  ToolContext,
  ToolResult,
  ToolParameterSchema,
} from "../../types/tool/interfaces";
import { log } from "../../utils/misc/logger";

export class AdvancedAdminTool extends BaseTool {
  name = "advanced_admin_action";
  description = "Perform advanced administrative actions. Only available to authorized users under specific conditions.";
  category = "admin" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["cleanup", "backup", "analyze", "reset"],
        description: "Administrative action to perform"
      },
      target: {
        type: "string",
        description: "Target for the action (optional)",
      },
      confirm: {
        type: "boolean",
        description: "Confirmation that user understands the action",
        default: false
      }
    },
    required: ["action"],
  };

  // Feature flag requirement
  requiresFeatureFlag = "advanced_admin_enabled";
  
  // Discord permission requirements
  requiresPermissions = ["ADMINISTRATOR", "MANAGE_GUILD"];

  /**
   * Basic availability: All providers support this tool
   */
  isAvailableFor(provider: string): boolean {
    // Available for all providers
    return true;
  }

  /**
   * Context-aware availability with comprehensive conditional logic
   */
  isAvailableForContext(provider: string, context?: ToolContext): boolean {
    // Always check base availability first
    if (!this.isAvailableFor(provider)) {
      log.debug("AdvancedAdminTool: Provider not supported");
      return false;
    }

    // No context means fallback to basic availability
    if (!context?.streamContext) {
      log.debug("AdvancedAdminTool: No stream context, using basic availability");
      return true;
    }

    const streamContext = context.streamContext;

    // 1. OPERATIONAL MODE RESTRICTIONS
    if (streamContext.operationMode) {
      // Disable during maintenance
      if (streamContext.operationMode === 'maintenance') {
        log.info("AdvancedAdminTool: Disabled during maintenance mode");
        return false;
      }
      
      // Only enable during debugging for debug actions
      if (streamContext.operationMode === 'debugging' && !this.isDebugAction(context)) {
        log.info("AdvancedAdminTool: Non-debug actions disabled during debugging mode");
        return false;
      }
    }

    // 2. USER PERMISSION LEVEL CHECKING
    if (streamContext.userPermissionLevel) {
      // Require admin level or higher
      const requiredLevel = 'admin';
      if (!this.hasRequiredPermissionLevel(streamContext.userPermissionLevel, requiredLevel)) {
        log.info(`AdvancedAdminTool: User permission level ${streamContext.userPermissionLevel} insufficient, requires ${requiredLevel}`);
        return false;
      }
    }

    // 3. TIME-BASED RESTRICTIONS
    if (streamContext.timeRestrictions) {
      if (!this.isWithinAllowedTime(streamContext.timeRestrictions)) {
        log.info("AdvancedAdminTool: Outside allowed time window");
        return false;
      }
    }

    // 4. RESOURCE CONSTRAINTS
    if (streamContext.resourceConstraints) {
      if (streamContext.resourceConstraints === 'low') {
        log.info("AdvancedAdminTool: Disabled due to low resource availability");
        return false;
      }
    }

    // 5. SYSTEM LOAD RESTRICTIONS  
    if (streamContext.systemLoad === 'high') {
      log.info("AdvancedAdminTool: Disabled due to high system load");
      return false;
    }

    // 6. RATE LIMITING
    if (streamContext.userRequestCount !== undefined) {
      const maxRequestsPerSession = 3;
      if (streamContext.userRequestCount >= maxRequestsPerSession) {
        log.info(`AdvancedAdminTool: Rate limited - user has made ${streamContext.userRequestCount} requests (max: ${maxRequestsPerSession})`);
        return false;
      }
    }

    // 7. SAFETY MODE RESTRICTIONS
    if (streamContext.safeMode && this.isPotentiallyDangerous()) {
      log.info("AdvancedAdminTool: Disabled in safe mode for dangerous operations");
      return false;
    }

    // 8. CUSTOM BUSINESS LOGIC
    if (!this.passesCustomAvailabilityChecks(context)) {
      return false;
    }

    log.debug("AdvancedAdminTool: All availability checks passed");
    return true;
  }

  /**
   * Execute the admin tool with comprehensive error handling
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Validate parameters
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: "Invalid parameters",
        message: "Please provide a valid action for the admin tool."
      };
    }

    const action = args.action as string;
    const target = args.target as string | undefined;
    const confirm = args.confirm as boolean || false;

    // Safety check for destructive actions
    if (this.isDestructiveAction(action) && !confirm) {
      return {
        success: false,
        error: "Confirmation required",
        message: "This action requires explicit confirmation. Please set confirm=true.",
        data: {
          action,
          requires_confirmation: true,
          warning: "This action may have irreversible effects."
        }
      };
    }

    log.info(`AdvancedAdminTool: Executing ${action} for ${context.tomoriState.server_id}`);

    try {
      // Execute based on action type
      const result = await this.executeAction(action, target, context);
      
      // Log successful admin action
      await this.logAdminAction(action, target, context, result);

      return {
        success: true,
        message: `Successfully executed ${action}${target ? ` on ${target}` : ''}`,
        data: result
      };

    } catch (error) {
      log.error(`AdvancedAdminTool: Failed to execute ${action}`, error as Error);
      
      // Log failed admin action for audit
      await this.logAdminAction(action, target, context, null, error as Error);

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown admin error",
        message: `Failed to execute ${action}. Please check the logs and try again.`,
        data: {
          action,
          target,
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  // HELPER METHODS FOR CONTEXT-AWARE LOGIC

  /**
   * Check if current action is debug-related
   */
  private isDebugAction(context: ToolContext): boolean {
    // Example: Only analyze action is allowed during debug mode
    return context.message?.content.includes('analyze') || false;
  }

  /**
   * Check user permission level hierarchy
   */
  private hasRequiredPermissionLevel(userLevel: string, requiredLevel: string): boolean {
    const hierarchy = ['basic', 'premium', 'moderator', 'admin', 'owner'];
    const userIndex = hierarchy.indexOf(userLevel);
    const requiredIndex = hierarchy.indexOf(requiredLevel);
    
    return userIndex >= requiredIndex;
  }

  /**
   * Check time-based restrictions
   */
  private isWithinAllowedTime(timeRestrictions: any[]): boolean {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay(); // 0 = Sunday, 6 = Saturday
    
    // Example: Admin actions only allowed during business hours on weekdays
    const isWeekday = currentDay >= 1 && currentDay <= 5;
    const isBusinessHours = currentHour >= 9 && currentHour <= 17;
    
    if (timeRestrictions.includes('business_hours_only')) {
      return isWeekday && isBusinessHours;
    }
    
    return true;
  }

  /**
   * Check if action is potentially dangerous
   */
  private isPotentiallyDangerous(): boolean {
    // Define which actions are considered dangerous
    const dangerousActions = ['reset', 'cleanup'];
    return dangerousActions.length > 0; // Simplified for example
  }

  /**
   * Custom business logic checks
   */
  private passesCustomAvailabilityChecks(context: ToolContext): boolean {
    // Example: Check if server has admin tools enabled
    if (!context.tomoriState.config.admin_tools_enabled) {
      log.info("AdvancedAdminTool: Admin tools disabled for this server");
      return false;
    }

    // Example: Check cooldown period
    const lastAdminAction = context.streamContext?.lastAdminActionTime;
    if (lastAdminAction) {
      const cooldownMinutes = 5;
      const timeSinceLastAction = Date.now() - lastAdminAction;
      const cooldownMs = cooldownMinutes * 60 * 1000;
      
      if (timeSinceLastAction < cooldownMs) {
        log.info(`AdvancedAdminTool: Cooldown active, ${Math.ceil((cooldownMs - timeSinceLastAction) / 60000)} minutes remaining`);
        return false;
      }
    }

    return true;
  }

  /**
   * Check if action is destructive and requires confirmation
   */
  private isDestructiveAction(action: string): boolean {
    const destructiveActions = ['reset', 'cleanup'];
    return destructiveActions.includes(action);
  }

  /**
   * Execute the specific admin action
   */
  private async executeAction(
    action: string, 
    target: string | undefined, 
    context: ToolContext
  ): Promise<Record<string, unknown>> {
    switch (action) {
      case 'cleanup':
        return await this.performCleanup(target, context);
      
      case 'backup':
        return await this.performBackup(target, context);
      
      case 'analyze':
        return await this.performAnalysis(target, context);
      
      case 'reset':
        return await this.performReset(target, context);
      
      default:
        throw new Error(`Unknown admin action: ${action}`);
    }
  }

  /**
   * Log admin actions for audit trail
   */
  private async logAdminAction(
    action: string,
    target: string | undefined,
    context: ToolContext,
    result: Record<string, unknown> | null,
    error?: Error
  ): Promise<void> {
    const auditLog = {
      action,
      target,
      user_id: context.userId,
      server_id: context.tomoriState.server_id,
      timestamp: new Date().toISOString(),
      success: !error,
      result: result ? JSON.stringify(result) : null,
      error: error ? error.message : null,
      channel_id: context.channel.id,
    };

    // Store in database or external audit system
    log.info(`Admin Action Audit: ${JSON.stringify(auditLog)}`);
    
    // Optional: Store in database
    // await storeAdminAuditLog(auditLog);
  }

  // MOCK ACTION IMPLEMENTATIONS

  private async performCleanup(target: string | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    log.info(`Performing cleanup${target ? ` on ${target}` : ''}`);
    // Simulate cleanup operation
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return {
      operation: 'cleanup',
      target: target || 'server',
      items_cleaned: Math.floor(Math.random() * 100),
      space_recovered: `${Math.floor(Math.random() * 500)}MB`,
    };
  }

  private async performBackup(target: string | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    log.info(`Performing backup${target ? ` of ${target}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return {
      operation: 'backup',
      target: target || 'database',
      backup_size: `${Math.floor(Math.random() * 1000)}MB`,
      backup_location: '/backups/auto_' + Date.now(),
    };
  }

  private async performAnalysis(target: string | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    log.info(`Performing analysis${target ? ` on ${target}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    return {
      operation: 'analysis',
      target: target || 'system',
      metrics: {
        performance_score: Math.floor(Math.random() * 100),
        health_status: 'good',
        recommendations: ['Enable caching', 'Update dependencies'],
      },
    };
  }

  private async performReset(target: string | undefined, context: ToolContext): Promise<Record<string, unknown>> {
    log.info(`Performing reset${target ? ` of ${target}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return {
      operation: 'reset',
      target: target || 'configuration',
      items_reset: ['cache', 'temporary_files', 'session_data'],
      warning: 'Some user sessions may be affected',
    };
  }
}
```

## Step 3: Extend StreamingContext Interface

**File**: `src/types/tool/interfaces.ts` (add to existing interface)

```typescript
/**
 * Enhanced streaming context for advanced context-aware tools
 */
export interface StreamingContext {
  // Existing YouTube processing flag
  disableYouTubeProcessing: boolean;
  
  // User permission levels
  userPermissionLevel?: 'basic' | 'premium' | 'moderator' | 'admin' | 'owner';
  
  // Operational modes
  operationMode?: 'normal' | 'maintenance' | 'debugging' | 'safe_mode';
  
  // System resource information
  systemLoad?: 'low' | 'normal' | 'high';
  resourceConstraints?: 'low' | 'normal' | 'high';
  
  // Safety controls
  safeMode?: boolean;
  
  // Rate limiting
  userRequestCount?: number;
  sessionStartTime?: number;
  lastAdminActionTime?: number;
  
  // Time-based restrictions
  timeRestrictions?: ('business_hours_only' | 'weekdays_only' | 'weekends_only')[];
  
  // Feature toggles
  experimentalFeaturesEnabled?: boolean;
  
  // Custom context data
  customFlags?: Record<string, boolean>;
  metadata?: Record<string, unknown>;
}
```

## Step 4: Implement Context Builder

Create a utility for building rich streaming contexts:

**File**: `src/utils/context/streamingContextBuilder.ts`

```typescript
/**
 * Streaming Context Builder
 * Creates rich streaming contexts for context-aware tools
 */

import type { StreamingContext } from "../../types/tool/interfaces";
import type { TomoriState } from "../../types/db/schema";
import { log } from "../misc/logger";

export class StreamingContextBuilder {
  private context: StreamingContext = {
    disableYouTubeProcessing: false,
  };

  /**
   * Set user permission level based on Discord roles
   */
  withUserPermissions(userId: string, guildId: string): StreamingContextBuilder {
    // Mock implementation - replace with actual Discord role checking
    const userLevel = this.determineUserPermissionLevel(userId, guildId);
    this.context.userPermissionLevel = userLevel;
    return this;
  }

  /**
   * Set operational mode
   */
  withOperationMode(mode: 'normal' | 'maintenance' | 'debugging' | 'safe_mode'): StreamingContextBuilder {
    this.context.operationMode = mode;
    return this;
  }

  /**
   * Set system resource information
   */
  withSystemResources(load: 'low' | 'normal' | 'high', constraints?: 'low' | 'normal' | 'high'): StreamingContextBuilder {
    this.context.systemLoad = load;
    this.context.resourceConstraints = constraints || 'normal';
    return this;
  }

  /**
   * Enable safe mode
   */
  withSafeMode(enabled: boolean = true): StreamingContextBuilder {
    this.context.safeMode = enabled;
    return this;
  }

  /**
   * Set rate limiting information
   */
  withRateLimiting(requestCount: number, sessionStart: number, lastAdminAction?: number): StreamingContextBuilder {
    this.context.userRequestCount = requestCount;
    this.context.sessionStartTime = sessionStart;
    this.context.lastAdminActionTime = lastAdminAction;
    return this;
  }

  /**
   * Set time-based restrictions
   */
  withTimeRestrictions(...restrictions: ('business_hours_only' | 'weekdays_only' | 'weekends_only')[]): StreamingContextBuilder {
    this.context.timeRestrictions = restrictions;
    return this;
  }

  /**
   * Enable experimental features
   */
  withExperimentalFeatures(enabled: boolean = true): StreamingContextBuilder {
    this.context.experimentalFeaturesEnabled = enabled;
    return this;
  }

  /**
   * Add custom flags
   */
  withCustomFlags(flags: Record<string, boolean>): StreamingContextBuilder {
    this.context.customFlags = { ...this.context.customFlags, ...flags };
    return this;
  }

  /**
   * Add metadata
   */
  withMetadata(metadata: Record<string, unknown>): StreamingContextBuilder {
    this.context.metadata = { ...this.context.metadata, ...metadata };
    return this;
  }

  /**
   * YouTube processing control
   */
  withYouTubeProcessing(enabled: boolean): StreamingContextBuilder {
    this.context.disableYouTubeProcessing = !enabled;
    return this;
  }

  /**
   * Build the final streaming context
   */
  build(): StreamingContext {
    return { ...this.context };
  }

  /**
   * Create context from Tomori state and environment
   */
  static fromTomoriState(tomoriState: TomoriState, userId?: string): StreamingContextBuilder {
    const builder = new StreamingContextBuilder();

    // Set operational mode based on configuration
    if (tomoriState.config.maintenance_mode) {
      builder.withOperationMode('maintenance');
    } else if (tomoriState.config.safe_mode_enabled) {
      builder.withOperationMode('safe_mode');
    }

    // Set user permissions if user ID provided
    if (userId) {
      builder.withUserPermissions(userId, tomoriState.discord_server_id);
    }

    // Set experimental features based on config
    builder.withExperimentalFeatures(tomoriState.config.experimental_features || false);

    // Add system resource monitoring
    const systemLoad = StreamingContextBuilder.getCurrentSystemLoad();
    builder.withSystemResources(systemLoad);

    return builder;
  }

  /**
   * Determine user permission level (mock implementation)
   */
  private determineUserPermissionLevel(userId: string, guildId: string): 'basic' | 'premium' | 'moderator' | 'admin' | 'owner' {
    // Mock implementation - replace with actual Discord role checking
    log.debug(`Determining permission level for user ${userId} in guild ${guildId}`);
    
    // This would typically check Discord roles, database permissions, etc.
    return 'admin'; // Mock return
  }

  /**
   * Get current system load (mock implementation)
   */
  private static getCurrentSystemLoad(): 'low' | 'normal' | 'high' {
    // Mock implementation - replace with actual system monitoring
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    
    if (heapUsedMB > 500) return 'high';
    if (heapUsedMB > 200) return 'normal';
    return 'low';
  }
}
```

## Step 5: Integration Example

Show how to use the context-aware tool in the main chat handler:

**File**: `src/events/messageCreate/tomoriChat.ts` (example integration)

```typescript
// In the main streaming loop, create rich context
const streamingContext = StreamingContextBuilder
  .fromTomoriState(tomoriState!, userDiscId)
  .withRateLimiting(getUserRequestCount(userDiscId), sessionStartTime, getLastAdminActionTime(userDiscId))
  .withTimeRestrictions('business_hours_only')
  .build();

// Pass context to provider for context-aware tool loading
const streamProviderPromise = await provider.streamToDiscord(
  channel,
  client,
  tomoriState!,
  providerConfig,
  contextSegments,
  accumulatedStreamedModelParts,
  emojiStrings,
  functionInteractionHistory.length > 0 ? functionInteractionHistory : undefined,
  undefined,
  isFromQueue ? message : undefined,
  streamingContext, // Rich context for context-aware tools
);
```

## Step 6: Testing Context-Aware Behavior

### Test Scenarios

1. **Permission Testing**:
   ```typescript
   // Test with different user levels
   const contexts = [
     { userPermissionLevel: 'basic' },     // Should hide admin tool
     { userPermissionLevel: 'admin' },     // Should show admin tool
   ];
   ```

2. **Time-Based Testing**:
   ```typescript
   // Mock different times
   const timeTests = [
     { timeRestrictions: ['business_hours_only'] }, // Test during/outside business hours
     { timeRestrictions: ['weekends_only'] },       // Test on weekdays/weekends
   ];
   ```

3. **System Load Testing**:
   ```typescript
   // Test under different system conditions
   const loadTests = [
     { systemLoad: 'low' },    // Should show all tools
     { systemLoad: 'high' },   // Should hide resource-intensive tools
   ];
   ```

### Manual Testing

```bash
# Test with different configurations
@TomoriBot perform advanced admin cleanup
# Should succeed if user is admin during business hours

@TomoriBot analyze system performance
# Should work in debug mode

@TomoriBot reset configuration confirm=true
# Should require explicit confirmation for destructive actions
```

## Key Patterns Demonstrated

### 1. **Graceful Degradation**
Always check base availability first, then add contextual logic.

### 2. **Comprehensive Logging**  
Log availability decisions for debugging and monitoring.

### 3. **Flexible Context Structure**
Use optional properties to avoid breaking existing tools.

### 4. **Business Logic Separation**
Keep complex availability logic in dedicated helper methods.

### 5. **Security First**
Always validate permissions and require confirmation for dangerous operations.

### 6. **Performance Awareness**
Consider system resources and rate limiting in availability decisions.

This context-aware tool demonstrates how TomoriBot's architecture enables sophisticated, intelligent tool management that adapts to runtime conditions while maintaining clean, maintainable code! 🚀

---

**Related Guides**:
- [Creating a New Tool](creating-new-tool.md)
- [Adding a New Provider](adding-new-provider.md)