/**
 * Response type for DeepL API
 */
export interface DeeplResponse {
	data: {
		translations: Array<{
			text: string;
			detected_source_language: string;
		}>;
	};
}

/**
 * Response type for Bing Translate API
 */
export interface BingResponse {
	translation: string;
	language: {
		from: string;
		to: string;
	};
}

/**
 * Response type for Google Translate API
 */
export interface GoogleResponse {
	text: string;
	from: {
		language: {
			iso: string;
		};
	};
}
