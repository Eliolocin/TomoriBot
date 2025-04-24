import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * Recursively retrieves all files or folders from a directory.
 * @param directory - The directory to search.
 * @param foldersOnly - If true, only folders are returned; otherwise, only files.
 * @returns An array of file or folder paths.
 */
const getAllFiles = (directory: string, foldersOnly = false): string[] => {
	const fileNames: string[] = [];

	const files = readdirSync(directory, { withFileTypes: true });

	for (const file of files) {
		const filePath = path.join(directory, file.name);

		if (foldersOnly) {
			if (file.isDirectory()) {
				fileNames.push(filePath);
			}
		} else {
			if (file.isFile()) {
				fileNames.push(filePath);
			}
		}
	}

	return fileNames;
};

export default getAllFiles;
