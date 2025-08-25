/**
 * TypeScript interfaces for Brave Search API responses
 * Based on official Brave Search API documentation
 * Supports Web, Image, Video, and News search endpoints
 */

// =============================================
// Common Types
// =============================================

/**
 * Query information present in all search types
 */
export interface Query {
	/** The original query that was requested */
	original: string;
	/** The altered query by the spellchecker (if any) */
	altered?: string;
	/** The cleaned normalized query by the spellchecker (if any) */
	cleaned?: string;
	/** Whether the spellchecker is enabled or disabled */
	spellcheck_off?: boolean;
	/** True if lack of results is due to strict safesearch */
	show_strict_warning?: boolean;
}

/**
 * Thumbnail information
 */
export interface Thumbnail {
	/** The served URL of the thumbnail */
	src: string;
	/** The original URL of the thumbnail (optional) */
	original?: string;
	/** Width of the thumbnail (optional) */
	width?: number;
	/** Height of the thumbnail (optional) */
	height?: number;
}

/**
 * Meta URL information
 */
export interface MetaUrl {
	/** The protocol scheme extracted from the URL */
	scheme?: string;
	/** The network location part extracted from the URL */
	netloc?: string;
	/** The lowercased domain name extracted from the URL */
	hostname?: string;
	/** The favicon used for the URL */
	favicon?: string;
	/** The hierarchical path of the URL useful as a display string */
	path?: string;
}

/**
 * Extra information about search results
 */
export interface Extra {
	/** Additional metadata about the search */
	[key: string]: unknown;
}

// =============================================
// Web Search Types
// =============================================

/**
 * Web search result
 */
export interface WebResult {
	/** The type of search result */
	type: "search_result";
	/** The URL of the search result */
	url: string;
	/** The title of the search result */
	title: string;
	/** The description/snippet of the search result */
	description?: string;
	/** A human readable representation of the page age */
	age?: string;
	/** The page age found from the source web page */
	page_age?: string;
	/** ISO date time when the page was last fetched */
	page_fetched?: string;
	/** Meta URL information */
	meta_url?: MetaUrl;
	/** Additional alternative snippets */
	extra_snippets?: string[];
}

/**
 * Web search API response
 */
/**
 * Web search results container
 */
export interface Search {
	/** The type of web search results */
	type: "search";
	/** Web search results */
	results: WebResult[];
	/** Extra information about the web search */
	extra?: Extra;
}

/**
 * News results container
 */
export interface News {
	/** News results */
	results: NewsResult[];
}

/**
 * Videos results container
 */  
export interface Videos {
	/** Video results */
	results: VideoResult[];
}

export interface WebSearchApiResponse {
	/** The type of search API result */
	type: "search";
	/** Search query information */
	query?: Query;
	/** Web search results */
	web?: Search;
	/** News results relevant to the query */
	news?: News;
	/** Videos relevant to the query */
	videos?: Videos;
	/** Extra information about the search */
	extra?: Extra;
}

// =============================================
// Image Search Types
// =============================================

/**
 * Image properties
 */
export interface ImageProperties {
	/** The image URL */
	url?: string;
	/** Lower resolution placeholder image URL */
	placeholder?: string;
	/** Width of the image */
	width?: number;
	/** Height of the image */
	height?: number;
}

/**
 * Image search result
 */
export interface ImageResult {
	/** The type of image search result */
	type: "image_result";
	/** The title of the image */
	title?: string;
	/** The original page URL where the image was found */
	url?: string;
	/** The source domain where the image was found */
	source?: string;
	/** ISO date time when the page was last fetched */
	page_fetched?: string;
	/** The thumbnail for the image */
	thumbnail?: Thumbnail;
	/** Metadata for the image */
	properties?: ImageProperties;
	/** Meta URL information */
	meta_url?: MetaUrl;
	/** Confidence level for the image result */
	confidence?: "low" | "medium" | "high";
}

/**
 * Image search API response
 */
export interface ImageSearchApiResponse {
	/** The type of search API result */
	type: "images";
	/** Image search query information */
	query: Query;
	/** Image search results */
	results: ImageResult[];
	/** Extra information about the search */
	extra: Extra;
}

// =============================================
// Video Search Types
// =============================================

/**
 * Profile information for video authors
 */
export interface Profile {
	/** The name of the profile */
	name: string;
	/** The long name of the profile */
	long_name?: string;
	/** The original URL where the profile is available */
	url: string;
	/** The served image URL representing the profile */
	img?: string;
}

/**
 * Video metadata
 */
export interface VideoData {
	/** A time string representing the duration of the video */
	duration?: string;
	/** The number of views of the video */
	views?: number;
	/** The creator of the video */
	creator?: string;
	/** The publisher of the video */
	publisher?: string;
	/** Whether the video requires a subscription */
	requires_subscription?: boolean;
	/** A list of tags relevant to the video */
	tags?: string[];
	/** Profile associated with the video */
	author?: Profile;
}

/**
 * Video search result
 */
export interface VideoResult {
	/** The type of video search result */
	type: "video_result";
	/** The source URL of the video */
	url: string;
	/** The title of the video */
	title: string;
	/** The description for the video */
	description?: string;
	/** A human readable representation of the page age */
	age?: string;
	/** The page age found from the source web page */
	page_age?: string;
	/** ISO date time when the page was last fetched */
	page_fetched?: string;
	/** The thumbnail for the video */
	thumbnail?: Thumbnail;
	/** Metadata for the video */
	video?: VideoData;
	/** Meta URL information */
	meta_url?: MetaUrl;
}

/**
 * Video search API response
 */
export interface VideoSearchApiResponse {
	/** The type of search API result */
	type: "videos";
	/** Video search query information */
	query: Query;
	/** Video search results */
	results: VideoResult[];
	/** Extra information about the search */
	extra: Extra;
}

// =============================================
// News Search Types
// =============================================

/**
 * News search result
 */
export interface NewsResult {
	/** The type of news search result */
	type: "news_result";
	/** The source URL of the news article */
	url: string;
	/** The title of the news article */
	title: string;
	/** The description for the news article */
	description?: string;
	/** A human readable representation of the page age */
	age?: string;
	/** The page age found from the source web page */
	page_age?: string;
	/** ISO date time when the page was last fetched */
	page_fetched?: string;
	/** Whether the result includes breaking news */
	breaking?: boolean;
	/** The thumbnail for the news article */
	thumbnail?: Thumbnail;
	/** Meta URL information */
	meta_url?: MetaUrl;
	/** A list of extra alternate snippets */
	extra_snippets?: string[];
}

/**
 * News search API response
 */
export interface NewsSearchApiResponse {
	/** The type of search API result */
	type: "news";
	/** News search query information */
	query: Query;
	/** News search results */
	results: NewsResult[];
}

// =============================================
// API Parameter Types
// =============================================

/**
 * Common search parameters
 */
export interface BaseSearchParams {
	/** The user's search query term (required) */
	q: string;
	/** The search query country (2 character country code) */
	country?: string;
	/** The search language preference (2+ character language code) */
	search_lang?: string;
	/** Whether to spellcheck the provided query */
	spellcheck?: boolean;
	/** Index signature for compatibility with Record<string, unknown> */
	[key: string]: unknown;
}

/**
 * Web search specific parameters
 */
export interface WebSearchParams extends BaseSearchParams {
	/** User interface language preferred in response */
	ui_lang?: string;
	/** Number of search results to return (max 20) */
	count?: number;
	/** Zero based offset for pagination (max 9) */
	offset?: number;
	/** Adult content filtering level */
	safesearch?: "off" | "moderate" | "strict";
	/** Filter results by discovery time */
	freshness?: "pd" | "pw" | "pm" | "py" | string; // Also supports date ranges
	/** Whether to include decoration markers in snippets */
	text_decorations?: boolean;
	/** Comma delimited string of result types to include */
	result_filter?: string;
	/** Measurement units */
	units?: "metric" | "imperial";
	/** Enable extra snippets (up to 5 additional excerpts) */
	extra_snippets?: boolean;
	/** Enable summary key generation */
	summary?: boolean;
}

/**
 * Image search specific parameters
 */
export interface ImageSearchParams extends BaseSearchParams {
	/** Number of search results to return (max 200) */
	count?: number;
	/** Adult content filtering level */
	safesearch?: "off" | "strict";
}

/**
 * Video search specific parameters
 */
export interface VideoSearchParams extends BaseSearchParams {
	/** User interface language preferred in response */
	ui_lang?: string;
	/** Number of search results to return (max 50) */
	count?: number;
	/** Zero based offset for pagination (max 9) */
	offset?: number;
	/** Adult content filtering level */
	safesearch?: "off" | "moderate" | "strict";
	/** Filter results by discovery time */
	freshness?: "pd" | "pw" | "pm" | "py" | string; // Also supports date ranges
}

/**
 * News search specific parameters
 */
export interface NewsSearchParams extends BaseSearchParams {
	/** User interface language preferred in response */
	ui_lang?: string;
	/** Number of search results to return (max 50) */
	count?: number;
	/** Zero based offset for pagination (max 9) */
	offset?: number;
	/** Adult content filtering level */
	safesearch?: "off" | "moderate" | "strict";
	/** Filter results by discovery time */
	freshness?: "pd" | "pw" | "pm" | "py" | string; // Also supports date ranges
	/** Enable extra snippets */
	extra_snippets?: boolean;
	/** Goggles for custom re-ranking */
	goggles?: string[];
}

// =============================================
// Error Types
// =============================================

/**
 * Brave API error response
 */
export interface BraveApiError {
	/** Error message */
	message: string;
	/** Error code */
	code?: string;
	/** HTTP status code */
	status?: number;
}

// =============================================
// Union Types for API Responses
// =============================================

/**
 * All possible Brave Search API responses
 */
export type BraveSearchResponse = 
	| WebSearchApiResponse 
	| ImageSearchApiResponse 
	| VideoSearchApiResponse 
	| NewsSearchApiResponse;

/**
 * All possible search result types
 */
export type BraveSearchResult = 
	| WebResult 
	| ImageResult 
	| VideoResult 
	| NewsResult;