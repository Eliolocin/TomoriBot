// Use Bun native API
import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Gets all files in a directory or all directories if getDirs is true
 * @param directory - The directory to scan
 * @param getDirs - Whether to return directories instead of files
 * @returns Array of absolute paths to files or directories
 */
export default function getAllFiles(
	directory: string,
	getDirs = false,
): string[] {
	try {
		// Read all items in the directory using Bun's API
		const items = readdirSync(directory, { withFileTypes: true });
		const result: string[] = [];

		// Filter items based on the getDirs flag
		for (const item of items) {
			const itemPath = path.join(directory, item.name);

			// Skip hidden files/directories (starting with .)
			if (item.name.startsWith(".")) continue;

			// Add directories or files based on getDirs flag
			if (item.isDirectory()) {
				if (getDirs) {
					result.push(itemPath);
				}
			} else if (!getDirs && item.isFile()) {
				// Only include JavaScript and TypeScript files
				if (itemPath.endsWith(".js") || itemPath.endsWith(".ts")) {
					result.push(itemPath);
				}
			}
		}

		return result;
	} catch (error) {
		console.error(`Error reading directory ${directory}:`, error);
		return [];
	}
}
