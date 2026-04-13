import { type App, TFile, TFolder, Notice, normalizePath } from "obsidian";
import type {
	InboxMessage,
	ClassifiedMessage,
	SignalInboxSettings,
} from "./types";
import { classifyMessage } from "./classifier";

/** Minimum age in ms before a file is considered stable enough to process. */
const FILE_SETTLE_MS = 2000;

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

	constructor(app: App, settings: SignalInboxSettings) {
		this.app = app;
		this.settings = settings;
	}

	updateSettings(settings: SignalInboxSettings): void {
		this.settings = settings;
	}

	/**
	 * Start watching the inbox folder.
	 */
	async start(): Promise<void> {
		// Ensure inbox and archive folders exist
		await this.ensureFolder(this.settings.inboxPath);
		await this.ensureFolder(this.settings.archivePath);

		// Build initial set of already-processed files
		await this.scanExisting();

		// Start polling
		this.pollInterval = window.setInterval(
			() => this.poll(),
			this.settings.pollIntervalSeconds * 1000
		);

		console.log(
			`Signal Inbox: Watching ${this.settings.inboxPath} every ${this.settings.pollIntervalSeconds}s`
		);
	}

	/**
	 * Stop watching.
	 */
	stop(): void {
		if (this.pollInterval !== null) {
			window.clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		console.log("Signal Inbox: Watcher stopped");
	}

	/**
	 * Restart the watcher (e.g. after settings change).
	 */
	async restart(): Promise<void> {
		this.stop();
		this.processedFiles.clear();
		await this.start();
	}

	/**
	 * Trigger a single poll without resetting state.
	 * Used by "Process now" command / ribbon icon.
	 */
	async processNow(): Promise<void> {
		await this.poll();
	}

	/**
	 * Scan existing inbox files so we don't re-process them on startup.
	 * Files that already have classification metadata are marked as processed.
	 * Unclassified files are left for the next poll to pick up.
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

	/**
	 * Check for new files in the inbox.
	 */
	private async poll(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			const folder = this.app.vault.getAbstractFileByPath(
				normalizePath(this.settings.inboxPath)
			);

			if (!(folder instanceof TFolder)) {
				return;
			}

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

	/**
	 * Process a single inbox file: parse, classify, and file it.
	 */
	private async processFile(file: TFile): Promise<void> {
		try {
			const content = await this.app.vault.read(file);

			// Skip files that were already classified (e.g. moved back to inbox)
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
				const classified = await classifyMessage(message, this.settings);
				await this.fileMessage(classified, file);
			}

			this.processedFiles.add(file.path);
		} catch (error) {
			console.error(`Signal Inbox: Error processing ${file.name}:`, error);
			this.processedFiles.add(file.path);
		}
	}

	/**
	 * File a classified message into the appropriate folder.
	 * Adds classification metadata to frontmatter and moves the file.
	 */
	private async fileMessage(
		classified: ClassifiedMessage,
		originalFile: TFile
	): Promise<void> {
		const enrichedContent = this.buildEnrichedContent(classified);
		const oldPath = originalFile.path;

		if (this.settings.autoFile) {
			// Auto-file: enrich and move to category folder
			const destFolder = normalizePath(classified.suggestedPath);
			await this.ensureFolder(destFolder);
			const destPath = this.deduplicatePath(destFolder, originalFile.name);

			await this.app.vault.modify(originalFile, enrichedContent);
			await this.app.vault.rename(originalFile, destPath);

			// Clean up old path so a new file with the same name gets processed
			this.processedFiles.delete(oldPath);

			new Notice(
				`Signal Inbox: Filed "${classified.summary}" -> ${classified.category}`
			);
		} else {
			// No auto-file: enrich and move to archive (out of inbox)
			const archiveFolder = normalizePath(this.settings.archivePath);
			await this.ensureFolder(archiveFolder);
			const destPath = this.deduplicatePath(archiveFolder, originalFile.name);

			await this.app.vault.modify(originalFile, enrichedContent);
			await this.app.vault.rename(originalFile, destPath);

			this.processedFiles.delete(oldPath);

			new Notice(
				`Signal Inbox: Classified "${classified.summary}" as ${classified.category} (in archive)`
			);
		}
	}

	/**
	 * Check whether content already has signal-inbox classification metadata.
	 */
	private isAlreadyClassified(content: string): boolean {
		return /^signal-inbox-category:/m.test(content);
	}

	/**
	 * Build markdown content with classification metadata in frontmatter.
	 */
	private buildEnrichedContent(classified: ClassifiedMessage): string {
		const body = this.stripFrontmatter(classified.content);

		const fm: Record<string, unknown> = {
			...classified.frontmatter,
			"signal-inbox-category": classified.category,
			"signal-inbox-summary": classified.summary,
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

	/**
	 * Safely encode a value as a YAML scalar.
	 */
	private yamlScalar(value: unknown): string {
		if (value === null || value === undefined) return '""';
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		const str = String(value);
		// Quote strings that contain YAML-special characters or could be misinterpreted
		if (
			str === "" ||
			str === "true" || str === "false" ||
			str === "null" || str === "~" ||
			/^[\d.eE+-]+$/.test(str) ||
			/[:#\[\]{}&*!|>'"%@`,?]/.test(str) ||
			str.startsWith("- ") ||
			str !== str.trim()
		) {
			return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return str;
	}

	/**
	 * Parse YAML frontmatter from markdown content.
	 */
	private parseFrontmatter(content: string): Record<string, unknown> {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match) return {};

		const result: Record<string, unknown> = {};
		const lines = match[1].split("\n");
		let currentKey = "";
		let currentArray: string[] | null = null;

		for (const line of lines) {
			// Array continuation: "  - value"
			if (/^\s+-\s/.test(line) && currentArray !== null) {
				const val = line.replace(/^\s+-\s*/, "").replace(/^["']|["']$/g, "");
				currentArray.push(val);
				continue;
			}

			// Flush any pending array
			if (currentArray !== null) {
				result[currentKey] = currentArray;
				currentArray = null;
			}

			const colonIndex = line.indexOf(":");
			if (colonIndex <= 0) continue;

			const key = line.slice(0, colonIndex).trim();
			const rawValue = line.slice(colonIndex + 1).trim();

			if (rawValue === "" || rawValue === "[]") {
				// Could be start of an array block, or empty value
				currentKey = key;
				currentArray = rawValue === "[]" ? null : [];
				if (rawValue === "[]") result[key] = [];
				continue;
			}

			currentKey = key;
			result[key] = rawValue.replace(/^["']|["']$/g, "");
		}

		// Flush trailing array
		if (currentArray !== null) {
			result[currentKey] = currentArray;
		}

		return result;
	}

	/**
	 * Strip frontmatter from markdown content, returning just the body.
	 */
	private stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
	}

	/**
	 * Generate a destination path, adding a numeric suffix if a file already exists.
	 */
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

	/**
	 * Ensure a folder exists in the vault, creating it recursively if needed.
	 */
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
