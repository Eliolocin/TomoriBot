const { REST, Routes } = require("discord.js");
const clientId = process.env.TOMO_ID;
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.TESTSRV_ID;
import { log } from "../src/utils/misc/logger";

const rest = new REST().setToken(token);

log.section("Purging TomoriBot's Command List...");

rest
	.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] })
	.then(() => log.success("Successfully deleted all guild commands."))
	.catch(console.error);

rest
	.put(Routes.applicationCommands(clientId), { body: [] })
	.then(() => log.success("Successfully deleted all application commands."))
	.catch(console.error);
