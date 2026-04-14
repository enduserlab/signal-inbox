import { type App, TFile, TFolder, Notice, normalizePath } from "obsidian";
import type {
	InboxMessage,
	ClassifiedMessage,
	SignalInboxSettings,
} from "./types";
import { classifyMessage } from "./classifier";

/** Minimum age in ms before a file is considered stable enough to process. */
const FILE_SETTLE_MS = 2000;

/** Callback for status bar updates. */
export type StatusCallback = (status: string) => void;

/** Callback to persist API call count. */
export type SaveSettingsCallback = () => Promise<void>;

/**
 * Watches the inbox folder for new files, classifies them,
 * and files them into the appropriate wiki locations.
 */
export class InboxWatcher {
	private app: App;
	private settings: SignalInboxSettings;
	private pollInterval: number | null = null;
	private processedFiles: Set<string> = new Set();
	private processing: boolean = false;
	private statusCb: StatusCallback = () => {};
	private saveCb: SaveSettingsCallback = async () => {};
	private sessionProcessed: number = 0;

	constructor(app: App, settings: SignalInboxSettings) {
		this.app = app;
		this.settings = settings;
	}

	updateSettings(settings: SignalInboxSettings): void {
		this.settings = settings;
	}

	onStatus(cb: StatusCallback): void {
		this.statusCb = cb;
	}

	onSave(cb: SaveSettingsCallback): void {
		this.saveCb = cb;
	}

	/**
	 * Start watching the inbox folder.
	 */
	async start(): Promise<void> {
		await this.ensureFolder(this.settings.inboxPath);
		await this.ensureFolder(this.settings.archivePath);
		await this.scanExisting();

		this.pollInterval = window.setInterval(
			() => { void this.poll(); },
			this.settings.pollIntervalSeconds * 1000
		);

		this.statusCb(`Watching (${this.sessionProcessed} processed)`);
	}

	stop(): void {
		if (this.pollInterval !== null) {
			window.clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		this.statusCb("Stopped");
	}

	async restart(): Promise<void> {
		this.stop();
		this.processedFiles.clear();
		await this.start();
	}

	async processNow(): Promise<void> {
		await this.poll();
	}

	/**
	 * Re-classify a specific file. Strips existing classification
	 * and runs it through the pipeline again.
	 */
	async reclassifyFile(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const body = this.stripFrontmatter(content);
		const fm = this.parseFrontmatter(content);

		// Remove existing classification fields
		for (const key of Object.keys(fm)) {
			if (key.startsWith("signal-inbox-")) {
				delete fm[key];
			}
		}

		// Rebuild clean content
		const cleanContent = Object.keys(fm).length > 0
			? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${this.yamlScalar(v)}`).join("\n")}\n---\n\n${body}`
			: body;

		const message: InboxMessage = {
			filename: file.name,
			filepath: file.path,
			content: cleanContent,
			frontmatter: fm,
			receivedAt: new Date(file.stat.ctime),
		};

		if (!this.checkDailyLimit()) return;

		this.statusCb("Re-classifying...");
		const classified = await classifyMessage(message, this.settings);
		await this.incrementApiCount();

		// Write enriched content back in place (don't move)
		const enrichedContent = this.buildEnrichedContent(classified);
		const newName = this.buildFilename(classified);
		const dir = file.parent?.path ?? "";
		const newPath = this.deduplicatePath(dir, newName);

		await this.app.vault.modify(file, enrichedContent);
		if (newPath !== file.path) {
			await this.app.vault.rename(file, newPath);
		}

		this.statusCb(`Watching (${this.sessionProcessed} processed)`);
		new Notice(`Signal Inbox: Re-classified as ${classified.category} — "${classified.summary}"`);
	}

	/**
	 * Scan existing inbox files. Already-classified files are marked processed.
	 */
	private async scanExisting(): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(this.settings.inboxPath)
		);
		if (!(folder instanceof TFolder)) return;

		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === "md") {
				const content = await this.app.vault.read(child);
				if (this.isAlreadyClassified(content)) {
					this.processedFiles.add(child.path);
				}
			}
		}
	}

	private async poll(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const folder = this.app.vault.getAbstractFileByPath(
				normalizePath(this.settings.inboxPath)
			);
			if (!(folder instanceof TFolder)) return;

			const now = Date.now();
			const newFiles: TFile[] = [];
			for (const child of folder.children) {
				if (
					child instanceof TFile &&
					child.extension === "md" &&
					!this.processedFiles.has(child.path) &&
					(now - child.stat.mtime) >= FILE_SETTLE_MS
				) {
					newFiles.push(child);
				}
			}

			if (newFiles.length === 0) return;

			new Notice(`Signal Inbox: ${newFiles.length} new message(s) detected`);

			for (const file of newFiles) {
				await this.processFile(file);
			}
		} catch (error) {
			console.error("Signal Inbox: Poll error:", error);
		} finally {
			this.processing = false;
		}
	}

	private async processFile(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.read(file);

			if (this.isAlreadyClassified(content)) {
				this.processedFiles.add(file.path);
				return;
			}

			const frontmatter = this.parseFrontmatter(content);

			const message: InboxMessage = {
				filename: file.name,
				filepath: file.path,
				content,
				frontmatter,
				receivedAt: new Date(file.stat.ctime),
			};

			if (this.settings.autoClassify) {
				if (!this.checkDailyLimit()) {
					this.processedFiles.add(file.path);
					return;
				}

				this.statusCb("Classifying...");
				const classified = await classifyMessage(message, this.settings);
				await this.incrementApiCount();
				this.sessionProcessed++;

				await this.fileMessage(classified, file);
				this.statusCb(`Watching (${this.sessionProcessed} processed)`);
			}

			this.processedFiles.add(file.path);
		} catch (error) {
			console.error(`Signal Inbox: Error processing ${file.name}:`, error);
			this.processedFiles.add(file.path);
			this.statusCb(`Error — ${this.sessionProcessed} processed`);
		}
	}

	/**
	 * File a classified message. Respects confidence threshold:
	 * - Above threshold + autoFile → category folder
	 * - Below threshold or !autoFile → archive
	 */
	private async fileMessage(
		classified: ClassifiedMessage,
		originalFile: TFile
	): Promise<void> {
		const enrichedContent = this.buildEnrichedContent(classified);
		const oldPath = originalFile.path;
		const newFilename = this.buildFilename(classified);

		const aboveThreshold = classified.confidence >= this.settings.confidenceThreshold;

		if (this.settings.autoFile && aboveThreshold) {
			const destFolder = normalizePath(classified.suggestedPath);
			await this.ensureFolder(destFolder);
			const destPath = this.deduplicatePath(destFolder, newFilename);

			await this.app.vault.modify(originalFile, enrichedContent);
			await this.app.vault.rename(originalFile, destPath);
			this.processedFiles.delete(oldPath);

			new Notice(`Signal Inbox: Filed "${classified.summary}" → ${classified.category}`);
		} else {
			const archiveFolder = normalizePath(this.settings.archivePath);
			await this.ensureFolder(archiveFolder);
			const destPath = this.deduplicatePath(archiveFolder, newFilename);

			await this.app.vault.modify(originalFile, enrichedContent);
			await this.app.vault.rename(originalFile, destPath);
			this.processedFiles.delete(oldPath);

			if (this.settings.autoFile && !aboveThreshold) {
				new Notice(
					`Signal Inbox: Low confidence (${(classified.confidence * 100).toFixed(0)}%) — "${classified.summary}" sent to archive for review`
				);
			} else {
				new Notice(
					`Signal Inbox: Classified "${classified.summary}" as ${classified.category} (in archive)`
				);
			}
		}
	}

	// --- Filename ---

	/**
	 * Build a human-readable filename: "Sender - 2026-04-12 - Topic.md"
	 */
	private buildFilename(classified: ClassifiedMessage): string {
		const rawSender = classified.frontmatter.sender ?? classified.frontmatter.source ?? "Unknown";
		const sender = this.cleanForFilename(
			typeof rawSender === "string" ? rawSender : "Unknown"
		);

		const date = classified.receivedAt.toISOString().slice(0, 10); // YYYY-MM-DD

		const topic = classified.topic
			? this.cleanForFilename(classified.topic)
			: this.cleanForFilename(classified.summary.slice(0, 40));

		return `${sender} - ${date} - ${topic}.md`;
	}

	private cleanForFilename(str: string): string {
		return str
			.replace(/[\\/:*?"<>|]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 50);
	}

	// --- API limit tracking ---

	private checkDailyLimit(): boolean {
		if (this.settings.dailyApiLimit <= 0) return true; // 0 = unlimited

		const today = new Date().toISOString().slice(0, 10);
		if (this.settings._apiCallsDate !== today) {
			// New day — reset counter
			this.settings._apiCallsToday = 0;
			this.settings._apiCallsDate = today;
		}

		if (this.settings._apiCallsToday >= this.settings.dailyApiLimit) {
			new Notice(
				`Signal Inbox: Daily API limit reached (${this.settings.dailyApiLimit}). Messages will be processed tomorrow or increase the limit in settings.`
			);
			return false;
		}

		return true;
	}

	private async incrementApiCount(): Promise<void> {
		const today = new Date().toISOString().slice(0, 10);
		if (this.settings._apiCallsDate !== today) {
			this.settings._apiCallsToday = 0;
			this.settings._apiCallsDate = today;
		}
		this.settings._apiCallsToday++;
		await this.saveCb();
	}

	// --- Frontmatter ---

	private isAlreadyClassified(content: string): boolean {
		return /^signal-inbox-category:/m.test(content);
	}

	private buildEnrichedContent(classified: ClassifiedMessage): string {
		const body = this.stripFrontmatter(classified.content);

		const fm: Record<string, unknown> = {
			...classified.frontmatter,
			"signal-inbox-category": classified.category,
			"signal-inbox-summary": classified.summary,
			"signal-inbox-topic": classified.topic,
			"signal-inbox-tags": classified.tags,
			"signal-inbox-confidence": classified.confidence,
			"signal-inbox-priority": classified.priority,
			"signal-inbox-suggested-path": classified.suggestedPath,
			"signal-inbox-received": classified.receivedAt.toISOString(),
			"signal-inbox-classified": new Date().toISOString(),
		};

		if (classified.people.length > 0) {
			fm["signal-inbox-people"] = classified.people;
		}
		if (classified.dates.length > 0) {
			fm["signal-inbox-dates"] = classified.dates;
		}
		if (classified.actions.length > 0) {
			fm["signal-inbox-actions"] = classified.actions;
		}
		if (classified.urlMeta.length > 0) {
			fm["signal-inbox-urls"] = classified.urlMeta.map(
				(u) => u.title ? `${u.title} (${u.url})` : u.url
			);
		}

		const yamlLines = Object.entries(fm).map(([key, value]) => {
			if (Array.isArray(value)) {
				if (value.length === 0) return `${key}: []`;
				return `${key}:\n${value.map((v) => `  - ${this.yamlScalar(v)}`).join("\n")}`;
			}
			return `${key}: ${this.yamlScalar(value)}`;
		});

		return `---\n${yamlLines.join("\n")}\n---\n\n${body}`;
	}

	private yamlScalar(value: unknown): string {
		if (value === null || value === undefined) return '""';
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (typeof value !== "string") return '""';
		const str = value;
		if (
			str === "" ||
			str === "true" || str === "false" ||
			str === "null" || str === "~" ||
			/^[\d.eE+-]+$/.test(str) ||
			/[:#[\]{}&*!|>'"%@`,?]/.test(str) ||
			str.startsWith("- ") ||
			str !== str.trim()
		) {
			return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return str;
	}

	private parseFrontmatter(content: string): Record<string, unknown> {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match) return {};

		const result: Record<string, unknown> = {};
		const lines = match[1].split("\n");
		let currentKey = "";
		let currentArray: string[] | null = null;

		for (const line of lines) {
			if (/^\s+-\s/.test(line) && currentArray !== null) {
				const val = line.replace(/^\s+-\s*/, "").replace(/^["']|["']$/g, "");
				currentArray.push(val);
				continue;
			}

			if (currentArray !== null) {
				result[currentKey] = currentArray;
				currentArray = null;
			}

			const colonIndex = line.indexOf(":");
			if (colonIndex <= 0) continue;

			const key = line.slice(0, colonIndex).trim();
			const rawValue = line.slice(colonIndex + 1).trim();

			if (rawValue === "" || rawValue === "[]") {
				currentKey = key;
				currentArray = rawValue === "[]" ? null : [];
				if (rawValue === "[]") result[key] = [];
				continue;
			}

			currentKey = key;
			result[key] = rawValue.replace(/^["']|["']$/g, "");
		}

		if (currentArray !== null) {
			result[currentKey] = currentArray;
		}

		return result;
	}

	private stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	}

	private deduplicatePath(folder: string, filename: string): string {
		const base = filename.replace(/\.md$/, "");
		let candidate = normalizePath(`${folder}/${filename}`);
		let i = 1;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${folder}/${base} ${i}.md`);
			i++;
		}
		return candidate;
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFolder) return;

		const parts = normalized.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) {
				await this.app.vault.createFolder(current);
			}
		}
	}
}
