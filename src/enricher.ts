import { requestUrl } from "obsidian";

/** Extracted metadata from a URL. */
export interface UrlMeta {
	url: string;
	title: string;
	description: string;
	siteName: string;
	/** First ~500 chars of visible text for Claude context */
	snippet: string;
	fetchedAt: string;
	error?: string;
}

/** Max body size to parse (bytes). */
const MAX_BODY_BYTES = 200_000;

/**
 * Extract URLs from message content.
 */
export function extractUrls(content: string): string[] {
	const regex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
	const matches = content.match(regex) ?? [];
	// Deduplicate
	return [...new Set(matches)];
}

/**
 * Fetch metadata for a list of URLs. Returns results for all URLs,
 * with error fields for any that failed.
 */
export async function fetchUrlMetadata(urls: string[]): Promise<UrlMeta[]> {
	const results: UrlMeta[] = [];

	for (const url of urls.slice(0, 5)) { // Cap at 5 URLs per message
		try {
			const meta = await fetchSingleUrl(url);
			results.push(meta);
		} catch {
			results.push({
				url,
				title: "",
				description: "",
				siteName: "",
				snippet: "",
				fetchedAt: new Date().toISOString(),
				error: "fetch failed",
			});
		}
	}

	return results;
}

/**
 * Fetch and parse metadata from a single URL.
 */
async function fetchSingleUrl(url: string): Promise<UrlMeta> {
	const response = await requestUrl({
		url,
		method: "GET",
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; ObsidianSignalInbox/0.1)",
			"Accept": "text/html,application/xhtml+xml,*/*",
		},
		throw: false,
	});

	if (response.status >= 400) {
		return {
			url,
			title: "",
			description: "",
			siteName: "",
			snippet: "",
			fetchedAt: new Date().toISOString(),
			error: `HTTP ${response.status}`,
		};
	}

	const html = response.text.slice(0, MAX_BODY_BYTES);

	const title = extractMeta(html, [
		/<meta\s+property="og:title"\s+content="([^"]*?)"/i,
		/<meta\s+name="twitter:title"\s+content="([^"]*?)"/i,
		/<title[^>]*>([\s\S]*?)<\/title>/i,
	]);

	const description = extractMeta(html, [
		/<meta\s+property="og:description"\s+content="([^"]*?)"/i,
		/<meta\s+name="description"\s+content="([^"]*?)"/i,
		/<meta\s+name="twitter:description"\s+content="([^"]*?)"/i,
	]);

	const siteName = extractMeta(html, [
		/<meta\s+property="og:site_name"\s+content="([^"]*?)"/i,
	]);

	// Extract visible text snippet for Claude context
	const snippet = extractTextSnippet(html);

	return {
		url,
		title: decodeHtmlEntities(title),
		description: decodeHtmlEntities(description),
		siteName: decodeHtmlEntities(siteName),
		snippet,
		fetchedAt: new Date().toISOString(),
	};
}

/**
 * Try multiple regex patterns against HTML and return the first match.
 */
function extractMeta(html: string, patterns: RegExp[]): string {
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]?.trim()) {
			return match[1].trim();
		}
	}
	return "";
}

/**
 * Strip HTML tags and extract a readable text snippet.
 */
function extractTextSnippet(html: string): string {
	// Remove scripts, styles, nav, header, footer
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<nav[\s\S]*?<\/nav>/gi, " ")
		.replace(/<header[\s\S]*?<\/header>/gi, " ")
		.replace(/<footer[\s\S]*?<\/footer>/gi, " ");

	// Try to find the main content area
	const articleMatch = text.match(/<article[\s\S]*?<\/article>/i)
		?? text.match(/<main[\s\S]*?<\/main>/i);
	if (articleMatch) {
		text = articleMatch[0];
	}

	// Strip remaining tags
	text = text.replace(/<[^>]+>/g, " ");
	// Collapse whitespace
	text = text.replace(/\s+/g, " ").trim();

	return text.slice(0, 500);
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/");
}

/**
 * Format URL metadata as context for the Claude classification prompt.
 */
export function formatUrlContext(metas: UrlMeta[]): string {
	const successful = metas.filter((m) => !m.error && (m.title || m.snippet));
	if (successful.length === 0) return "";

	const sections = successful.map((m) => {
		const parts = [`URL: ${m.url}`];
		if (m.title) parts.push(`Title: ${m.title}`);
		if (m.siteName) parts.push(`Site: ${m.siteName}`);
		if (m.description) parts.push(`Description: ${m.description}`);
		if (m.snippet) parts.push(`Content preview: ${m.snippet}`);
		return parts.join("\n");
	});

	return `\n\nLinked content:\n---\n${sections.join("\n---\n")}\n---`;
}
