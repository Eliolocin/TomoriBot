import {
	ActionRowBuilder,
	ApplicationCommandOptionType,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	ChatInputCommandInteraction,
	Client,
	ComponentType,
	EmbedBuilder,
} from "discord.js";
import NanaAPI from "nana-api";
import { Command, IUser } from "../../types/global";
import { localizer } from "../../utils/textLocalizer";

const nana = new NanaAPI();

interface DoujinResult {
	id: string;
	media_id: string;
	tags: Array<{ name: string }>;
	title: {
		english: string;
		japanese: string;
		pretty: string;
	};
}

const command: Command = {
	name: "doujin",
	description:
		"Get 4 Random Doujins from Nhentai | Nhentaiから4つのランダムな同人誌を取得します",
	category: "scrape",
	options: [
		{
			name: "random",
			description: "Retrieve 4 random doujins from Nhentai.",
			type: ApplicationCommandOptionType.Subcommand,
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

			const leftButton = new ButtonBuilder()
				.setLabel("◀ Previous")
				.setStyle(ButtonStyle.Primary)
				.setCustomId("prev-page")
				.setDisabled(true);

			const rightButton = new ButtonBuilder()
				.setLabel("Next ▶")
				.setStyle(ButtonStyle.Primary)
				.setCustomId("next-page");

			const results: DoujinResult[] = [];
			for (let i = 0; i < 4; i++) {
				try {
					const randomId = Math.floor(Math.random() * 462120);
					const doujin = await nana.g(randomId);
					if (doujin) {
						results.push(doujin);
					}
				} catch (error) {
					console.error(`Failed to fetch doujin ${i + 1}:`, error);
					continue;
				}
			}

			if (results.length === 0) {
				throw new Error("Could not fetch any valid results");
			}

			let idx = 0;
			const total = results.length;
			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				leftButton,
				rightButton,
			);

			const setPage = (index: number) => {
				const doujin = results[index];
				return new EmbedBuilder()
					.setColor("#DE3163")
					.setTitle(
						localizer(locale, "scrape.doujin.embed.title", {
							title:
								locale === "ja"
									? doujin.title.japanese || doujin.title.english
									: doujin.title.english,
							index: index + 1,
							total,
						}),
					)
					.setURL(`https://nhentai.net/g/${doujin.id}/`)
					.setImage(
						`https://t.nhentai.net/galleries/${doujin.media_id}/thumb.jpg`,
					)
					.setFooter({
						text: localizer(locale, "scrape.doujin.footer_tags", {
							tags: doujin.tags.map((tag) => tag.name).join(", "),
						}),
					});
			};

			let embed = setPage(idx);

			const reply = await interaction.editReply({
				embeds: [embed],
				components: [row],
			});

			const collector = reply.createMessageComponentCollector({
				componentType: ComponentType.Button,
				time: 30000,
			});

			collector.on("collect", async (button: ButtonInteraction) => {
				idx += button.customId === "prev-page" ? -1 : 1;
				leftButton.setDisabled(idx === 0);
				rightButton.setDisabled(idx === total - 1);

				const newEmbed = setPage(idx);
				await button.update({ embeds: [newEmbed], components: [row] });
			});

			collector.on("end", async () => {
				leftButton.setDisabled(true);
				rightButton.setDisabled(true);
				await interaction.editReply({ components: [row] });
			});
		} catch (err) {
			console.error("Error in Doujin command:", err);
			const embed = new EmbedBuilder()
				.setColor("#FF0000")
				.setTitle(localizer(locale, "scrape.doujin.error_no_results"))
				.setDescription(err instanceof Error ? err.message : "Unknown error");

			await interaction.editReply({ embeds: [embed] });
		}
	},
} as const;

export default command;
