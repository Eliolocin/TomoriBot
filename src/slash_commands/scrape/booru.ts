import createBooru, { Post } from "booru";
import {
	ApplicationCommandOptionType,
	ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	TextChannel,
} from "discord.js";
import { Eiyuu } from "eiyuu";
import { Command, IUser } from "../../types/global";
import { getFormattedSource } from "../../utils/formatSource";
import { localizer } from "../../utils/textLocalizer";

const resolve = new Eiyuu();
const postfiltering = {
	general: " score:>=3 rating:general",
	sensitive: " score:>=3 -rating:general -rating:explicit",
	explicit: " score:>=3 rating:explicit",
};

const command: Command = {
	name: "booru",
	description:
		"Retrieve 4 Search Results from Gelbooru | Gelbooruから検索結果を4つ取得します",
	category: "scrape",
	options: [
		{
			name: "rating",
			description: "Choose content rating | コンテンツの評価を選択してください",
			type: ApplicationCommandOptionType.String,
			required: true,
			choices: [
				{ name: "General", value: "general" },
				{ name: "Sensitive", value: "sensitive" },
				{ name: "Explicit (NSFW Only)", value: "explicit" },
			],
		},
		{
			name: "tags",
			description:
				"Enter tags separated by commas | タグをカンマで区切って入力してください",
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
		const rating = interaction.options.getString("rating") || "general";
		try {
			// NSFW Check
			if (rating === "explicit") {
				const channel = interaction.channel;
				if (
					!channel?.isTextBased() ||
					!(channel instanceof TextChannel) ||
					!channel.nsfw
				) {
					const embed = new EmbedBuilder()
						.setColor("#FF0000")
						.setTitle(localizer(locale, "scrape.booru.error_not_nsfw"));

					await interaction.reply({ embeds: [embed], ephemeral: true });
					return;
				}
			}
			await interaction.deferReply();
			const userquery = interaction.options.getString("tags", true); // Mark as required
			const tags = userquery.split(",").map((tag) => tag.trim());
			let finalQuery = "";

			for (const tag of tags) {
				const resolvedTags = await resolve.gelbooru(tag.replace(/\s+/g, "_"));
				finalQuery += ` ${resolvedTags[0]}`;
			}

			// Add rating-specific filtering
			const filteredQuery = `${finalQuery}${postfiltering[rating as keyof typeof postfiltering]}`;

			const queryEmbed = new EmbedBuilder()
				.setColor("#00FF00")
				.setTitle(localizer(locale, "scrape.booru.query_comparison_title"))
				.setDescription(
					localizer(locale, "scrape.booru.query_comparison_description", {
						original: userquery,
						filtered: finalQuery.trim(),
					}),
				);

			await interaction.editReply({ embeds: [queryEmbed] });

			const booru = createBooru("gelbooru");
			const posts = await booru.search(filteredQuery.trim().split(/\s+/), {
				limit: 4,
				random: true,
			});

			const booruPosts = posts.map((post: Post) => ({
				fileUrl: post.fileUrl,
				source: typeof post.source === "string" ? post.source : post.fileUrl,
				id: post.id,
				tags: Array.isArray(post.tags) ? post.tags.join(", ") : post.tags,
				score: post.score,
				rating: post.rating,
				createdAt: post.createdAt ? new Date(post.createdAt) : new Date(),
				postView: post.postView,
			}));

			if (!booruPosts.length) {
				const embed = new EmbedBuilder()
					.setColor("#FF0000")
					.setTitle(localizer(locale, "scrape.booru.error_no_results"))
					.setDescription(
						localizer(locale, "scrape.booru.error_no_results", {
							query: userquery,
						}),
					);

				await interaction.editReply({ embeds: [embed] });
				return;
			}

			const embeds = booruPosts.map((post, index) =>
				new EmbedBuilder()
					.setColor("#00FF00")
					.setTitle(
						localizer(locale, "scrape.booru.result_title", {
							source: getFormattedSource(post.source),
						}),
					)
					.setURL(post.source || post.fileUrl)
					.setImage(post.fileUrl)
					.setFooter({
						text: localizer(locale, "scrape.booru.result_footer", {
							score: post.score,
							tags: userquery,
						}),
					}),
			);

			await interaction.editReply({
				embeds,
			});
		} catch (err) {
			console.error("Error in Booru command:", err);
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "scrape.booru.error_message"))
				.setDescription(err instanceof Error ? err.message : "Unknown error");

			await interaction.editReply({ embeds: [embed] });
		}
	},
} as const;

export default command;
