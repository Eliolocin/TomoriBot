# Creating a New Tool

This tutorial walks through creating a new tool for TomoriBot, using a **Weather Tool** as an example. You'll learn the complete process from implementation to integration.

## Overview

We'll create a weather tool that:
- Fetches weather data from an API
- Supports multiple locations
- Includes temperature, conditions, and forecast
- Works across all LLM providers
- Includes proper error handling
- Demonstrates both **Built-in Tool** and **REST API Tool** patterns

## Step 1: Create Tool Implementation

Create the tool file:

**File**: `src/tools/functionCalls/weatherTool.ts`

```typescript
/**
 * Weather Tool - Fetches current weather and forecast data
 * Provides weather information for any location worldwide
 */

import { BaseTool } from "../../types/tool/interfaces";
import type {
  ToolContext,
  ToolResult,
  ToolParameterSchema,
} from "../../types/tool/interfaces";
import { log } from "../../utils/misc/logger";

interface WeatherData {
  location: string;
  temperature: number;
  condition: string;
  humidity: number;
  windSpeed: number;
  forecast?: Array<{
    date: string;
    high: number;
    low: number;
    condition: string;
  }>;
}

export class WeatherTool extends BaseTool {
  name = "get_weather";
  description = "Get current weather and forecast for any location. Supports cities, regions, and coordinates.";
  category = "utility" as const;

  parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "Location to get weather for (e.g., 'Tokyo', 'New York, NY', '40.7128,-74.0060')",
      },
      include_forecast: {
        type: "boolean",
        description: "Whether to include 3-day forecast",
        default: false,
      },
      units: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "Temperature units",
        default: "celsius",
      }
    },
    required: ["location"],
  };

  // Available for all providers
  isAvailableFor(_provider: string): boolean {
    return true;
  }

  // Optional: Context-aware availability
  isAvailableForContext(provider: string, context?: ToolContext): boolean {
    if (!this.isAvailableFor(provider)) return false;
    
    // Example: Disable during maintenance mode
    if (context?.streamContext?.operationMode === 'maintenance') {
      return false;
    }
    
    return true;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Validate parameters
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: `Invalid parameters: ${validation.errors?.join(", ")}`,
        message: "Please provide a valid location for the weather query."
      };
    }

    const location = args.location as string;
    const includeForecast = args.include_forecast as boolean || false;
    const units = args.units as string || "celsius";

    log.info(`WeatherTool: Fetching weather for ${location}`);

    try {
      // Fetch weather data
      const weatherData = await this.fetchWeatherData(location, includeForecast, units);
      
      // Format response
      const response = this.formatWeatherResponse(weatherData, includeForecast);

      log.success(`WeatherTool: Successfully retrieved weather for ${location}`);

      return {
        success: true,
        message: `Here's the current weather for ${weatherData.location}`,
        data: {
          location: weatherData.location,
          current: {
            temperature: weatherData.temperature,
            condition: weatherData.condition,
            humidity: weatherData.humidity,
            windSpeed: weatherData.windSpeed,
          },
          forecast: weatherData.forecast,
          formatted_response: response,
        }
      };

    } catch (error) {
      log.error(`WeatherTool: Failed to fetch weather for ${location}`, error as Error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown weather API error",
        message: "I couldn't fetch the weather data right now. Please try again later or check if the location name is correct.",
        data: {
          location: location,
          status: "api_error",
        }
      };
    }
  }

  /**
   * Fetch weather data from external API
   * In production, you'd use a real weather API like OpenWeatherMap
   */
  private async fetchWeatherData(
    location: string, 
    includeForecast: boolean,
    units: string
  ): Promise<WeatherData> {
    // Example implementation with mock data
    // Replace with real API call in production
    
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Mock weather data (replace with real API)
    const mockWeatherData: WeatherData = {
      location: location,
      temperature: units === "fahrenheit" ? 75 : 24,
      condition: "Partly cloudy",
      humidity: 65,
      windSpeed: 12,
    };

    if (includeForecast) {
      mockWeatherData.forecast = [
        { date: "Tomorrow", high: 26, low: 18, condition: "Sunny" },
        { date: "Day 2", high: 23, low: 16, condition: "Cloudy" },
        { date: "Day 3", high: 21, low: 14, condition: "Light rain" },
      ];
    }

    return mockWeatherData;
  }

  /**
   * Format weather data for display
   */
  private formatWeatherResponse(weatherData: WeatherData, includeForecast: boolean): string {
    let response = `🌤️ Weather in ${weatherData.location}:\n`;
    response += `Temperature: ${weatherData.temperature}°\n`;
    response += `Condition: ${weatherData.condition}\n`;
    response += `Humidity: ${weatherData.humidity}%\n`;
    response += `Wind Speed: ${weatherData.windSpeed} km/h`;

    if (includeForecast && weatherData.forecast) {
      response += `\n\n📅 3-Day Forecast:\n`;
      weatherData.forecast.forEach(day => {
        response += `${day.date}: ${day.high}°/${day.low}° - ${day.condition}\n`;
      });
    }

    return response;
  }
}
```

## Step 2: Export the Tool

Add your tool to the exports:

**File**: `src/tools/functionCalls/index.ts`

```typescript
// ... existing exports
export { WeatherTool } from "./weatherTool";
```

## Alternative: REST API Tool Pattern

For external APIs requiring complex processing, consider the **REST API Tool** pattern used by Brave Search. This approach provides better separation of concerns and enhanced data flow.

### REST API Tool Structure

**File Structure**: `src/tools/restAPIs/weather/`
```
weather/
├── types.ts              # API response interfaces
├── weatherService.ts     # Core HTTP service functions  
├── toolImplementations.ts # MCP-compatible function implementations
├── tools.ts              # BaseTool extensions
└── index.ts              # Clean exports
```

### Example REST API Implementation

**File**: `src/tools/restAPIs/weather/types.ts`
```typescript
export interface WeatherApiResponse {
  location: string;
  current: {
    temperature: number;
    condition: string;
    humidity: number;
  };
  forecast?: WeatherForecast[];
}

export interface WeatherSearchParams {
  location: string;
  include_forecast?: boolean;
  units?: "celsius" | "fahrenheit";
  [key: string]: unknown; // For Record compatibility
}
```

**File**: `src/tools/restAPIs/weather/weatherService.ts`
```typescript
export async function fetchWeatherData(
  params: WeatherSearchParams,
  config: { serverId?: number } = {}
): Promise<ApiResult<WeatherApiResponse>> {
  // REST API implementation with server-specific API keys
  const apiKey = await getOptApiKey(config.serverId, "weather-api") || process.env.WEATHER_API_KEY;
  
  const response = await fetch(`https://api.weather.com/data?location=${params.location}&key=${apiKey}`);
  const data = await response.json();
  
  return { success: true, data };
}
```

**File**: `src/tools/restAPIs/weather/toolImplementations.ts`
```typescript
export async function get_weather(
  args: Record<string, unknown>,
  context?: ToolContext
): Promise<{ success: boolean; message: string; data?: unknown; error?: string }> {
  const startTime = Date.now();
  
  try {
    const result = await fetchWeatherData(params, { serverId });
    
    return {
      success: true,
      message: "Weather data retrieved successfully",
      data: {
        // MCP-compatible data structure for rich LLM processing
        source: "http",
        functionName: "get_weather", 
        serverName: "weather-api",
        rawResult: {
          functionResponse: {
            name: "get_weather",
            response: {
              content: [{ type: "text", text: formattedWeather }],
              isError: false
            }
          }
        },
        executionTime: Date.now() - startTime,
        location: result.data.location,
        status: "completed"
      }
    };
  } catch (error) {
    return {
      success: false,
      message: "Failed to fetch weather data",
      error: (error as Error).message
    };
  }
}
```

**File**: `src/tools/restAPIs/weather/tools.ts`
```typescript
export class WeatherTool extends BaseTool {
  name = "get_weather";
  description = "Get current weather for any location";
  
  protected convertToToolResult(result: {
    success: boolean;
    message: string;
    data?: unknown;  // ← Critical: Preserve rich data!
    error?: string;
  }): ToolResult {
    const toolResult: ToolResult = {
      success: result.success,
      message: result.message,
    };
    
    if (result.data) {
      toolResult.data = result.data; // ← Ensures data flows to LLM
    }
    
    if (result.error) {
      toolResult.error = result.error;
    }
    
    return toolResult;
  }
  
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const result = await get_weather(args, context);
    return this.convertToToolResult(result); // ← Rich data preserved
  }
}
```

### Key REST API Tool Benefits

✅ **Rich Data Flow**: Data structure flows from service → implementation → tool class → LLM
✅ **MCP Compatibility**: Same response format as MCP servers
✅ **Extensibility**: Easy to replicate for other external APIs  
✅ **Error Handling**: Centralized API key validation and user-friendly embeds
✅ **Type Safety**: Full TypeScript coverage throughout the pipeline

## Step 3: Test Your Tool

### Development Testing

1. **Start development server**:
   ```bash
   bun run dev
   ```

2. **Test in Discord**:
   - Mention your bot: `@TomoriBot what's the weather in Tokyo?`
   - The AI should automatically call your weather tool
   - Verify the response formatting and data

### Manual Testing Examples

Test various scenarios:

```
# Basic usage
@TomoriBot get weather for New York

# With forecast
@TomoriBot what's the weather in London with forecast?

# Different units
@TomoriBot Tokyo weather in Fahrenheit

# Error cases
@TomoriBot weather for invalid-location-12345
```

## Step 4: Advanced Features

### Add Real Weather API Integration

Replace mock data with a real weather service:

```typescript
// Add to your .env file
OPENWEATHER_API_KEY=your_api_key_here

// Update fetchWeatherData method
private async fetchWeatherData(
  location: string, 
  includeForecast: boolean,
  units: string
): Promise<WeatherData> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) {
    throw new Error("Weather API key not configured");
  }

  const unitsParam = units === "fahrenheit" ? "imperial" : "metric";
  const currentWeatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=${unitsParam}`;
  
  const response = await fetch(currentWeatherUrl);
  if (!response.ok) {
    throw new Error(`Weather API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  
  return {
    location: `${data.name}, ${data.sys.country}`,
    temperature: Math.round(data.main.temp),
    condition: data.weather[0].description,
    humidity: data.main.humidity,
    windSpeed: Math.round(data.wind.speed * 3.6), // Convert m/s to km/h
  };
}
```

### Add Context-Aware Features

Make your tool smarter based on context:

```typescript
isAvailableForContext(provider: string, context?: ToolContext): boolean {
  if (!this.isAvailableFor(provider)) return false;
  
  // Disable during high system load
  if (context?.streamContext?.systemLoad === 'high') {
    log.info("WeatherTool: Disabled due to high system load");
    return false;
  }
  
  // Rate limiting per user
  if (context?.streamContext?.userRequestCount && context.streamContext.userRequestCount > 10) {
    log.info("WeatherTool: Rate limited for user");
    return false;
  }
  
  return true;
}
```

### Add Permission Controls

Restrict tool access based on server configuration:

```typescript
export class WeatherTool extends BaseTool {
  // ... existing code
  
  // Require specific feature flag
  requiresFeatureFlag = "weather_enabled";
  
  // Optional: Require Discord permissions
  requiresPermissions = ["EMBED_LINKS"]; // Needed for rich embeds
}
```

## Step 5: Integration with Discord Embeds

Enhance the tool to send rich Discord embeds:

```typescript
import { sendStandardEmbed } from "../../utils/discord/embedHelper";
import { ColorCode } from "../../utils/misc/logger";

// In your execute method, after successful weather fetch:
try {
  // Send weather embed to Discord
  await sendStandardEmbed(context.channel, context.locale, {
    title: `🌤️ Weather in ${weatherData.location}`,
    description: this.formatWeatherResponse(weatherData, includeForecast),
    color: ColorCode.INFO,
    fields: [
      {
        name: "🌡️ Temperature",
        value: `${weatherData.temperature}°`,
        inline: true
      },
      {
        name: "💧 Humidity", 
        value: `${weatherData.humidity}%`,
        inline: true
      },
      {
        name: "💨 Wind",
        value: `${weatherData.windSpeed} km/h`,
        inline: true
      }
    ],
    timestamp: new Date().toISOString()
  });
} catch (embedError) {
  // Log but don't fail the tool execution
  log.warn(`Failed to send weather embed: ${embedError}`);
}
```

## Step 6: Error Handling Best Practices

### Comprehensive Error Coverage

```typescript
async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    // Parameter validation
    const validation = this.validateParameters(args);
    if (!validation.isValid) {
      return {
        success: false,
        error: "Invalid parameters",
        message: "Please provide a valid location for the weather query.",
        data: { validation_errors: validation.errors }
      };
    }

    // API availability check
    if (!process.env.OPENWEATHER_API_KEY) {
      return {
        success: false,
        error: "Weather service not configured",
        message: "The weather service is currently unavailable. Please try again later.",
        data: { status: "service_unavailable" }
      };
    }

    // Execute with timeout
    const weatherData = await Promise.race([
      this.fetchWeatherData(location, includeForecast, units),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error("Weather API timeout")), 10000)
      )
    ]);

    return { success: true, data: weatherData };

  } catch (error) {
    // Categorize errors for better user experience
    if (error instanceof Error) {
      if (error.message.includes("timeout")) {
        return {
          success: false,
          error: "API timeout",
          message: "The weather service is taking too long to respond. Please try again.",
          data: { status: "timeout" }
        };
      }
      
      if (error.message.includes("404") || error.message.includes("not found")) {
        return {
          success: false,
          error: "Location not found", 
          message: `I couldn't find weather data for "${location}". Please check the location name and try again.`,
          data: { status: "location_not_found", attempted_location: location }
        };
      }
    }

    // Generic error fallback
    log.error(`WeatherTool: Unexpected error`, error as Error);
    return {
      success: false,
      error: "Weather service error",
      message: "I encountered an issue getting the weather data. Please try again later.",
      data: { status: "unknown_error" }
    };
  }
}
```

## Testing Checklist

Before considering your tool complete:

- [ ] **TypeScript Compilation**: `bun run check` passes
- [ ] **Linting**: `bun run lint` passes  
- [ ] **Basic Functionality**: Tool executes successfully
- [ ] **Error Handling**: Invalid inputs handled gracefully
- [ ] **Provider Compatibility**: Works with your target LLM providers
- [ ] **Discord Integration**: Responses display properly in Discord
- [ ] **Performance**: No memory leaks or excessive API calls
- [ ] **Documentation**: JSDoc comments are comprehensive
- [ ] **Logging**: Appropriate info/error logging added

## Next Steps

After creating your tool:

1. **Add Tests**: Consider adding unit tests for complex logic
2. **Documentation**: Update relevant documentation
3. **Monitoring**: Add metrics collection if needed
4. **Security Review**: Ensure no sensitive data exposure
5. **Performance Optimization**: Monitor and optimize API usage

Your weather tool is now ready to provide weather information across all TomoriBot instances! 🌤️

---

**Related Guides**:
- [Context-Aware Tool Implementation](implementing-context-aware-tool.md)
- [Adding a New Provider](adding-new-provider.md)