import { Menu, Notice, Plugin, TFile } from "obsidian";
import type { SignalInboxSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { InboxWatcher } from "./watcher";
import { SignalInboxSettingTab } from "./settings";

export default class SignalInboxPlugin extends Plugin {
	settings: SignalInboxSettings = DEFAULT_SETTINGS;
	watcher: InboxWatcher | null = null;
	statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText("Signal Inbox: Starting...");

		// Start the inbox watcher
		this.watcher = new InboxWatcher(this.app, this.settings);
		this.watcher.onStatus((status) => {
			this.statusBarEl?.setText(`Signal Inbox: ${status}`);
		});
		this.watcher.onSave(() => this.saveSettings());
		await this.watcher.start();

		// Register cleanup on unload
		this.register(() => this.watcher?.stop());

		// Ribbon icon for manual processing
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

		// --- Commands ---

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
			id: "reclassify-file",
			name: "Re-classify current file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (checking) return true;

				if (!this.settings.claudeApiKey) {
					new Notice("Signal Inbox: Please set your Claude API key in settings.");
					return true;
				}

				new Notice("Signal Inbox: Re-classifying...");
				this.watcher?.reclassifyFile(file);
				return true;
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

		// --- File menu: Re-classify ---

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;

				menu.addItem((item) => {
					item
						.setTitle("Signal Inbox: Re-classify")
						.setIcon("refresh-cw")
						.onClick(async () => {
							if (!this.settings.claudeApiKey) {
								new Notice("Signal Inbox: Please set your Claude API key in settings.");
								return;
							}
							new Notice("Signal Inbox: Re-classifying...");
							await this.watcher?.reclassifyFile(file);
						});
				});
			})
		);

		// Settings tab
		this.addSettingTab(new SignalInboxSettingTab(this.app, this));

	}

	onunload(): void {
		// Cleanup handled by this.register() callbacks
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
		this.watcher?.updateSettings(this.settings);
	}
}
