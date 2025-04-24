declare module "nihongo" {
	/**
	 * Checks if a string contains Japanese characters
	 */
	export function hasJapanese(text: string): boolean;

	/**
	 * Counts Kanji characters in a string
	 */
	export function countKanji(text: string): number;

	/**
	 * Counts Kana characters in a string
	 */
	export function countKana(text: string): number;
}
