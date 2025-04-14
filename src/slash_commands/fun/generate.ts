import {
	ApplicationCommandOptionType,
	AttachmentBuilder,
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
} from "discord.js";
import { generate } from "stable-diffusion-cjs";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const command: Command = {
	name: "generate",
	description:
		"Generate images with Stable Diffusion | Stable Diffusionで画像を生成します",
	category: "fun",
	options: [
		{
			name: "prompt",
			description: "Generation Prompt | 生成プロンプト",
			type: ApplicationCommandOptionType.String,
			required: true,
		},
	],

	callback: async (
		client: Client,
		interaction: ChatInputCommandInteraction,
		userData: IUser,
	): Promise<void> => {
		const locale = userData.language || "en";

		try {
			await interaction.deferReply();
			const userPrompt = interaction.options.getString("prompt", true);

			const progressEmbed = new EmbedBuilder()
				.setColor("#FFD700")
				.setTitle(
					localizer(locale, "fun.generate.progress", { prompt: userPrompt }),
				)
				.setTimestamp();

			await interaction.editReply({ embeds: [progressEmbed] });

			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => {
					reject(new Error("Generation timed out after 30 seconds"));
				}, 30000);
			});

			const imageBuffer = await Promise.race([
				generate(userPrompt),
				timeoutPromise,
			]);

			const attachment = new AttachmentBuilder(imageBuffer, {
				name: "generated_image.png",
			});

			const resultEmbed = new EmbedBuilder()
				.setColor("#00FF00")
				.setTitle(
					localizer(locale, "fun.generate.result", { prompt: userPrompt }),
				)
				.setTimestamp();

			await interaction.editReply({
				embeds: [resultEmbed],
				files: [attachment],
			});
		} catch (err) {
			console.error("Error in generate command:", err);
			const errorEmbed = new EmbedBuilder()
				.setColor("#E74C3C")
				.setTitle(localizer(locale, "fun.generate.error"))
				.setDescription(err instanceof Error ? err.message : "Unknown error");

			await interaction.editReply({ embeds: [errorEmbed] });
		}
	},
} as const;

export default command;
