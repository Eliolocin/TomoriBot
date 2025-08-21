/**
 * Provider Factory for creating LLM provider instances
 * This factory implements the switch statement based on the llm_provider setting
 * and provides a clean interface for getting the appropriate provider.
 */

import { log } from "../misc/logger";
import type {
	LLMProvider,
	ProviderInfo,
} from "../../types/provider/interfaces";
import type { TomoriState } from "../../types/db/schema";

// Import provider implementations
// Note: We'll add these imports as we create the providers
// import { GoogleProvider } from "./google/GoogleProvider";
// import { OpenAIProvider } from "./openai/OpenAIProvider";
// import { AnthropicProvider } from "./anthropic/AnthropicProvider";

/**
 * Supported LLM providers
 */
export enum ProviderType {
	GOOGLE = "google",
	OPENAI = "openai",
	ANTHROPIC = "anthropic",
}

/**
 * Provider factory namespace for creating LLM provider instances
 */
export namespace ProviderFactory {
	const providerInstances = new Map<ProviderType, LLMProvider>();

	/**
	 * Get a provider instance based on the provider type
	 * Uses singleton pattern to reuse provider instances
	 * @param providerType - The type of provider to create
	 * @returns The provider instance
	 * @throws Error if provider is not supported
	 */
	function getProviderInstance(providerType: ProviderType): LLMProvider {
		// Check if we already have an instance
		if (providerInstances.has(providerType)) {
			const instance = providerInstances.get(providerType);
			if (instance) {
				return instance;
			}
		}

		// Create new provider instance based on type
		let provider: LLMProvider;

		switch (providerType) {
			case ProviderType.GOOGLE: {
				// Import the Google provider
				const {
					GoogleProvider,
				} = require("../../providers/google/googleProvider");
				provider = new GoogleProvider();
				break;
			}

			case ProviderType.OPENAI: {
				throw new Error("OpenAI provider is not yet implemented");
				// Future implementation:
				// const { OpenAIProvider } = require("./openai/OpenAIProvider");
				// provider = new OpenAIProvider();
				// break;
			}

			case ProviderType.ANTHROPIC: {
				throw new Error("Anthropic provider is not yet implemented");
				// Future implementation:
				// const { AnthropicProvider } = require("./anthropic/AnthropicProvider");
				// provider = new AnthropicProvider();
				// break;
			}

			default: {
				throw new Error(`Unsupported provider type: ${providerType}`);
			}
		}

		// Cache the instance
		providerInstances.set(providerType, provider);
		log.info(`Created new provider instance: ${providerType}`);

		return provider;
	}

	/**
	 * Get a provider based on the TomoriState configuration
	 * @param tomoriState - The Tomori state containing LLM provider information
	 * @returns The appropriate provider instance
	 * @throws Error if provider is not supported or not configured
	 */
	export function getProvider(tomoriState: TomoriState): LLMProvider {
		if (!tomoriState.llm?.llm_provider) {
			throw new Error("No LLM provider configured in TomoriState");
		}

		const providerName = tomoriState.llm.llm_provider.toLowerCase().trim();

		// Convert provider name to enum
		let providerType: ProviderType;
		switch (providerName) {
			case "google":
			case "gemini": {
				providerType = ProviderType.GOOGLE;
				break;
			}
			case "openai":
			case "gpt": {
				providerType = ProviderType.OPENAI;
				break;
			}
			case "anthropic":
			case "claude": {
				providerType = ProviderType.ANTHROPIC;
				break;
			}
			default: {
				log.error(`Unsupported LLM provider: ${providerName}`, undefined, {
					serverId: tomoriState.server_id,
					errorType: "UnsupportedProviderError",
					metadata: {
						providerName,
						supportedProviders: Object.values(ProviderType),
					},
				});
				throw new Error(
					`Unsupported LLM provider: ${providerName}. Supported providers: ${Object.values(ProviderType).join(", ")}`,
				);
			}
		}

		// Validate that the configured model is supported by the provider
		const provider = getProviderInstance(providerType);
		const modelCodename = tomoriState.llm.llm_codename;

		if (
			modelCodename &&
			!provider.getInfo().supportedModels.includes(modelCodename)
		) {
			log.warn(
				`Model ${modelCodename} is not officially supported by provider ${providerName}. This may cause issues.`,
				{
					serverId: tomoriState.server_id,
					metadata: {
						providerName,
						modelCodename,
						supportedModels: provider.getInfo().supportedModels,
					},
				},
			);
		}

		log.info(`Using provider: ${providerName} with model: ${modelCodename}`);
		return provider;
	}

	/**
	 * Get all available providers and their information
	 * @returns Array of provider information objects
	 */
	export function getAvailableProviders(): Array<{
		type: ProviderType;
		info: ProviderInfo;
	}> {
		const availableProviders: Array<{
			type: ProviderType;
			info: ProviderInfo;
		}> = [];

		// Only include implemented providers
		try {
			const googleProvider = getProviderInstance(ProviderType.GOOGLE);
			availableProviders.push({
				type: ProviderType.GOOGLE,
				info: googleProvider.getInfo(),
			});
		} catch (error) {
			log.warn(
				`Google provider not available: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// Future: Add other providers when implemented
		// try {
		//   const openaiProvider = this.getProviderInstance(ProviderType.OPENAI);
		//   availableProviders.push({ type: ProviderType.OPENAI, info: openaiProvider.getInfo() });
		// } catch (error) {
		//   log.warn(`OpenAI provider not available: ${error.message}`);
		// }

		return availableProviders;
	}

	/**
	 * Check if a provider type is supported
	 * @param providerName - The provider name to check
	 * @returns True if the provider is supported
	 */
	export function isProviderSupported(providerName: string): boolean {
		const normalizedName = providerName.toLowerCase().trim();
		return (
			Object.values(ProviderType).includes(normalizedName as ProviderType) ||
			["gemini", "gpt", "claude"].includes(normalizedName)
		);
	}

	/**
	 * Clear all cached provider instances (useful for testing or reloading)
	 */
	export function clearCache(): void {
		providerInstances.clear();
		log.info("Cleared provider instance cache");
	}
}

/**
 * Convenience function to get a provider from TomoriState
 * @param tomoriState - The Tomori state
 * @returns The appropriate provider instance
 */
export function getProviderForTomori(tomoriState: TomoriState): LLMProvider {
	return ProviderFactory.getProvider(tomoriState);
}
