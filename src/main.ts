import { Notice, Plugin } from "obsidian";
import type { SignalInboxSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { InboxWatcher } from "./watcher";
import { SignalInboxSettingTab } from "./settings";

export default class SignalInboxPlugin extends Plugin {
	settings: SignalInboxSettings = DEFAULT_SETTINGS;
	watcher: InboxWatcher | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Start the inbox watcher
		this.watcher = new InboxWatcher(this.app, this.settings);
		await this.watcher.start();

		// Register cleanup on unload
		this.register(() => this.watcher?.stop());

		// Add ribbon icon for manual processing
		this.addRibbonIcon("inbox", "Signal Inbox: Process now", async () => {
			if (!this.settings.claudeApiKey) {
				new Notice(
					"Signal Inbox: Please set your Claude API key in settings."
				);
				return;
			}
			new Notice("Signal Inbox: Checking for new messages...");
			await this.watcher?.processNow();
		});

		// Add commands
		this.addCommand({
			id: "process-inbox",
			name: "Process inbox now",
			callback: async () => {
				if (!this.settings.claudeApiKey) {
					new Notice(
						"Signal Inbox: Please set your Claude API key in settings."
					);
					return;
				}
				new Notice("Signal Inbox: Processing inbox...");
				await this.watcher?.processNow();
			},
		});

		this.addCommand({
			id: "open-inbox-folder",
			name: "Open inbox folder",
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath(
					this.settings.inboxPath
				);
				if (folder) {
					// Reveal in file explorer
					const leaf = this.app.workspace.getLeaf(false);
					if (leaf) {
						await leaf.openFile(
							this.app.vault.getFiles().find(
								(f) => f.path.startsWith(this.settings.inboxPath)
							) ?? this.app.vault.getFiles()[0]
						);
					}
				} else {
					new Notice(
						`Signal Inbox: Inbox folder "${this.settings.inboxPath}" not found.`
					);
				}
			},
		});

		// Settings tab
		this.addSettingTab(new SignalInboxSettingTab(this.app, this));

		console.log("Signal Inbox plugin loaded");
	}

	onunload(): void {
		console.log("Signal Inbox plugin unloaded");
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Update watcher with new settings
		this.watcher?.updateSettings(this.settings);
	}
}
