import { join } from "node:path";
import { rmdir } from "node:fs/promises";
import { log } from "../src/utils/misc/logger";

const distPath = join(process.cwd(), "dist");

try {
	await rmdir(distPath, { recursive: true });
	log.success("Successfully cleaned dist directory");
} catch (error) {
	if ((error as { code?: string }).code !== "ENOENT") {
		log.error("Error cleaning dist directory:", error);
		process.exit(1);
	}
	// Directory doesn't exist, which is fine
	log.success("'dist' directory already clean");
}
