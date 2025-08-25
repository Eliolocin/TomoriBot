# Internationalization (i18n) - Adding New Languages

TomoriBot supports multiple languages through a simple localization system. Adding a new language is straightforward - just create a new locale file and follow the existing structure.

## Quick Start

### Step 1: Create Locale File

Create a new file in `src/locales/` using the Discord-supported language code:

**File**: `src/locales/es-ES.ts` (for Spanish)

```typescript
// Spanish localization for TomoriBot
export default {
	general: {
		// Cooldown messages
		cooldown_title: `¡Por favor espera!`,
		cooldown: `⏳ Necesitas esperar {seconds} segundos antes de usar un comando \`/{category}\` de nuevo.`,

		// Standard interaction responses
		interaction: {
			cancel_title: `❌ Operación Cancelada`,
			cancel_description: `La operación ha sido cancelada. ¡Puedes intentarlo de nuevo en cualquier momento!`,
			timeout_title: `⏰ Tiempo Agotado`,
			timeout_description: `No respondiste a tiempo. Por favor intenta de nuevo si quieres continuar.`,
		},

		// Continue translating following the en-US.ts structure...
		errors: {
			guild_only_title: `Comando Solo para Servidores`,
			guild_only_description: `Este comando solo puede ser usado en servidores de Discord.`,
			// ... more translations
		},
	},

	commands: {
		config: {
			name: `configuración`,
			description: `Gestiona la configuración del servidor`,
			// ... command translations
		},
		// ... more command translations
	},

	// Continue with all sections from en-US.ts
};
```

### Step 2: Follow the Reference Structure

**Reference**: Use `src/locales/en-US.ts` as your template. The structure includes:

- `general` - Common messages, errors, interactions
- `commands` - All slash command names and descriptions  
- `genai` - AI-related messages
- `tools` - Tool-specific messages
- `personality` - Personality system messages

### Step 3: Register the Locale (Optional)

The locale system auto-discovers files in `src/locales/`. No registration needed!

## Translation Guidelines

### 1. Preserve Placeholders

Always keep placeholder variables intact:

```typescript
// ✅ Correct
cooldown: `⏳ Necesitas esperar {seconds} segundos antes de usar \`/{category}\`.`,

// ❌ Wrong - removes placeholders
cooldown: `⏳ Necesitas esperar unos segundos antes de usar un comando.`,
```

### 2. Maintain Discord Formatting

Keep Discord markdown formatting:

```typescript
// ✅ Correct - preserves code blocks and formatting
description: `Configura el proveedor de IA usando \`/config set-provider\`.`,

// ❌ Wrong - removes formatting
description: `Configura el proveedor de IA usando /config set-provider.`,
```

### 3. Cultural Adaptation

Adapt messages for cultural context, not just literal translation:

```typescript
// English (casual)
success_message: `Nice! Configuration updated.`,

// Spanish (more formal is often preferred)
success_message: `¡Perfecto! Configuración actualizada.`,

// Japanese (very polite)
success_message: `設定が正常に更新されました。`,
```

## Supported Discord Languages

Use these language codes for your locale files:

- `en-US.ts` - English (US)
- `en-GB.ts` - English (UK)  
- `es-ES.ts` - Spanish
- `fr.ts` - French
- `de.ts` - German
- `it.ts` - Italian
- `pt-BR.ts` - Portuguese (Brazil)
- `ru.ts` - Russian
- `ja.ts` - Japanese
- `ko.ts` - Korean
- `zh-CN.ts` - Chinese (Simplified)
- `zh-TW.ts` - Chinese (Traditional)

[See full list of Discord locales](https://discord.com/developers/docs/reference#locales)

## Testing Your Translation

1. **Start development server**:
   ```bash
   bun run dev
   ```

2. **Test locale detection**:
   - Change your Discord language setting
   - Interact with TomoriBot
   - Verify messages appear in your language

3. **Test key commands**:
   ```
   /config set-language es-ES
   /help
   @TomoriBot hello
   ```

## Translation Completion Checklist

- [ ] All `general` section messages translated
- [ ] All `commands` section translated (names and descriptions)
- [ ] All `genai` section translated  
- [ ] All `tools` section translated
- [ ] Placeholders preserved (`{variable}`)
- [ ] Discord formatting preserved (``backticks``, **bold**)
- [ ] Cultural adaptation considered
- [ ] Tested with actual Discord interactions

## Pro Tips

### Use Reference Files
Compare with existing translations:
- `en-US.ts` - Original English (most complete)
- `ja.ts` - Japanese (good example of cultural adaptation)

### Partial Translations
You can translate gradually - untranslated keys fall back to English automatically.

### Community Contribution
Consider opening a pull request! Native speakers are always welcome to improve translations.

That's it! TomoriBot's i18n system makes localization as simple as creating one TypeScript file. 🌍

---

**Related**: [Contributing Guidelines](../09-contributing.md) for submitting translations