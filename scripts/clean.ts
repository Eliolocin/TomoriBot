import { join } from "path";
import { rmdir } from "fs/promises";

const distPath = join(process.cwd(), "dist");

try {
	await rmdir(distPath, { recursive: true });
	console.log("Successfully cleaned dist directory");
} catch (error) {
	if ((error as { code?: string }).code !== "ENOENT") {
		console.error("Error cleaning dist directory:", error);
		process.exit(1);
	}
	// Directory doesn't exist, which is fine
	console.log("dist directory already clean");
}
