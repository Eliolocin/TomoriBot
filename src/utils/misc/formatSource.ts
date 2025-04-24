export const getFormattedSource = (url: string | null | undefined): string => {
	if (!url) return "(No source provided)";
	try {
		const urlObj = new URL(url);
		const pathParts = urlObj.pathname.split("/").filter(Boolean);
		const relevantParts = pathParts.slice(0, 3);
		return `${urlObj.hostname}/${relevantParts.join("/")}`;
	} catch {
		return url;
	}
};
