import { requestUrl } from "obsidian";
import type {
	InboxMessage,
	ClassifiedMessage,
	MessageCategory,
	MessagePriority,
	SignalInboxSettings,
} from "./types";
import { extractUrls, fetchUrlMetadata, formatUrlContext } from "./enricher";

/** Max retries on transient failures (429, 5xx, network). */
const MAX_RETRIES = 2;

/** Base delay between retries (ms). Doubles each attempt. */
const RETRY_BASE_MS = 2000;

const DEFAULT_CLASSIFICATION_PROMPT = `You are a personal knowledge management assistant. Analyze the following message received via Signal messenger and extract structured metadata.

Respond with ONLY a JSON object (no markdown, no code fences) with these fields:

- "category": one of "article", "question", "task", "update", "reference", "idea", "conversation"
- "summary": a one-sentence summary (max 100 chars)
- "topic": a short 2-4 word topic label for the message (used in filenames, e.g. "auth service PR", "knowledge graphs article", "weekend plans")
- "tags": an array of 1-5 relevant tags (lowercase, hyphens, no spaces)
- "confidence": a number 0-1 for classification confidence
- "priority": one of "high", "medium", "low", "none"
  - "high": urgent, time-sensitive, or blocking someone
  - "medium": should address within a day or two
  - "low": eventually, no rush
  - "none": purely informational or social
- "people": array of names of people mentioned or involved (empty array if none)
- "dates": array of dates/deadlines mentioned, in ISO 8601 format where possible (empty array if none)
- "actions": array of suggested next actions, 1-3 short imperative sentences (empty array if not actionable)

Classification guidelines:
- "article": shared links, blog posts, news articles, papers, tweets with substantive content
- "question": someone asking something that warrants a response or follow-up
- "task": explicit or implied action items, requests to do something, deadlines
- "update": status updates, FYI messages, notifications, progress reports
- "reference": documentation, specs, how-tos, technical references worth keeping
- "idea": brainstorms, suggestions, creative proposals, what-if scenarios
- "conversation": casual chat, greetings, social messages, not directly actionable

Message:
---
{MESSAGE_CONTENT}
---
{URL_CONTEXT}

Respond with the JSON object only.`;

/**
 * Classifies a message using the Claude API, optionally enriched with URL content.
 * Retries on transient failures (429 rate limit, 5xx server errors).
 */
export async function classifyMessage(
	message: InboxMessage,
	settings: SignalInboxSettings
): Promise<ClassifiedMessage> {
	if (!settings.claudeApiKey) {
		return emptyClassification(message, settings, "No API key configured");
	}

	// Fetch URL metadata if enabled
	let urlContext = "";
	let urlMeta: ClassifiedMessage["urlMeta"] = [];
	if (settings.fetchUrls) {
		const urls = extractUrls(message.content);
		if (urls.length > 0) {
			const metas = await fetchUrlMetadata(urls);
			urlContext = formatUrlContext(metas);
			urlMeta = metas
				.filter((m) => !m.error)
				.map((m) => ({
					url: m.url,
					title: m.title,
					description: m.description,
					siteName: m.siteName,
				}));
		}
	}

	const prompt = (settings.classificationPrompt || DEFAULT_CLASSIFICATION_PROMPT)
		.replace("{MESSAGE_CONTENT}", message.content)
		.replace("{URL_CONTEXT}", urlContext);

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
			console.warn(`Signal Inbox: Retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
			await sleep(delay);
		}

		try {
			const response = await requestUrl({
				url: "https://api.anthropic.com/v1/messages",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": settings.claudeApiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: settings.claudeModel,
					max_tokens: 500,
					messages: [
						{
							role: "user",
							content: prompt,
						},
					],
				}),
			});

			const result = response.json;

			// Check for API errors that warrant retry
			if (result.error) {
				const errType = result.error.type ?? "";
				if (isRetryable(response.status, errType) && attempt < MAX_RETRIES) {
					lastError = new Error(`API error: ${result.error.message}`);
					continue;
				}
				throw new Error(`API error: ${result.error.message}`);
			}

			const textBlock = result.content?.find(
				(block: { type: string }) => block.type === "text"
			);

			if (!textBlock?.text) {
				throw new Error("No text response from Claude");
			}

			const c = JSON.parse(textBlock.text);

			const category: MessageCategory =
				isValidCategory(c.category) ? c.category : "unclassified";

			const priority: MessagePriority =
				isValidPriority(c.priority) ? c.priority : "none";

			return {
				...message,
				category,
				summary: typeof c.summary === "string" ? c.summary : "No summary",
				tags: Array.isArray(c.tags) ? c.tags : [],
				suggestedPath: settings.categoryFolders[category],
				confidence: typeof c.confidence === "number" ? c.confidence : 0.5,
				priority,
				people: Array.isArray(c.people) ? c.people : [],
				dates: Array.isArray(c.dates) ? c.dates : [],
				actions: Array.isArray(c.actions) ? c.actions : [],
				urlMeta,
				topic: typeof c.topic === "string" ? c.topic : "",
			};
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Check if this is a retryable HTTP status
			const statusMatch = lastError.message.match(/status (\d+)/);
			const status = statusMatch ? parseInt(statusMatch[1]) : 0;
			if (isRetryable(status, "") && attempt < MAX_RETRIES) {
				continue;
			}

			// Non-retryable error — bail out
			break;
		}
	}

	console.error("Signal Inbox: Classification failed:", lastError);
	return emptyClassification(
		message,
		settings,
		`Classification error: ${lastError?.message ?? "unknown"}`
	);
}

function isRetryable(status: number, errType: string): boolean {
	if (status === 429) return true; // Rate limited
	if (status >= 500) return true;  // Server error
	if (errType === "overloaded_error") return true;
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyClassification(
	message: InboxMessage,
	settings: SignalInboxSettings,
	summary: string
): ClassifiedMessage {
	return {
		...message,
		category: "unclassified",
		summary,
		tags: [],
		suggestedPath: settings.categoryFolders.unclassified,
		confidence: 0,
		priority: "none",
		people: [],
		dates: [],
		actions: [],
		urlMeta: [],
		topic: "",
	};
}

function isValidCategory(value: unknown): value is MessageCategory {
	const valid = [
		"article", "question", "task", "update",
		"reference", "idea", "conversation",
	];
	return typeof value === "string" && valid.includes(value);
}

function isValidPriority(value: unknown): value is MessagePriority {
	return typeof value === "string" && ["high", "medium", "low", "none"].includes(value);
}
