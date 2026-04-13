import { requestUrl } from "obsidian";
import type {
	InboxMessage,
	ClassifiedMessage,
	MessageCategory,
	MessagePriority,
	SignalInboxSettings,
} from "./types";
import { extractUrls, fetchUrlMetadata, formatUrlContext } from "./enricher";

const DEFAULT_CLASSIFICATION_PROMPT = `You are a personal knowledge management assistant. Analyze the following message received via Signal messenger and extract structured metadata.

Respond with ONLY a JSON object (no markdown, no code fences) with these fields:

- "category": one of "article", "question", "task", "update", "reference", "idea", "conversation"
- "summary": a one-sentence summary (max 100 chars)
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
		};
	} catch (error) {
		console.error("Signal Inbox: Classification failed:", error);
		return emptyClassification(
			message,
			settings,
			`Classification error: ${error instanceof Error ? error.message : "unknown"}`
		);
	}
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
