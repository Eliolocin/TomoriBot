import { sql } from "bun";
import { log } from "../src/utils/logBeautifier";
import path from "node:path";

log.section("TomoriBot Database Seeding...");

try {
	const seedPath = path.join(process.cwd(), "src", "db", "seed.sql");
	await sql.file(seedPath);
	log.success("Database seed script executed successfully!");
} catch (error) {
	log.error("Database seeding failed:", error);
	process.exit(1);
}
