import { App, PluginSettingTab, Setting } from "obsidian";
import type SignalInboxPlugin from "./main";
import type { MessageCategory } from "./types";

const CATEGORY_LABELS: Record<MessageCategory, string> = {
	article: "Articles & Links",
	question: "Questions",
	task: "Tasks & Action Items",
	update: "Updates & FYIs",
	reference: "References & Docs",
	idea: "Ideas & Brainstorms",
	conversation: "Conversations",
	unclassified: "Unclassified",
};

export class SignalInboxSettingTab extends PluginSettingTab {
	plugin: SignalInboxPlugin;

	constructor(app: App, plugin: SignalInboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Claude API ---
		containerEl.createEl("h2", { text: "Claude API" });

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("Your Anthropic API key for message classification.")
			.addText((text) => {
				text
					.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.claudeApiKey)
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Claude model to use for classification.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("claude-sonnet-4-20250514", "Claude Sonnet 4")
					.addOption("claude-haiku-4-5-20251001", "Claude Haiku 4.5 (faster, cheaper)")
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Inbox Paths ---
		containerEl.createEl("h2", { text: "Inbox Paths" });

		new Setting(containerEl)
			.setName("Inbox folder")
			.setDesc(
				"Folder to watch for incoming messages. The signal-bridge drops files here."
			)
			.addText((text) =>
				text
					.setPlaceholder("_inbox/signal")
					.setValue(this.plugin.settings.inboxPath)
					.onChange(async (value) => {
						this.plugin.settings.inboxPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Archive folder")
			.setDesc("Where processed messages are moved after filing.")
			.addText((text) =>
				text
					.setPlaceholder("_inbox/processed")
					.setValue(this.plugin.settings.archivePath)
					.onChange(async (value) => {
						this.plugin.settings.archivePath = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Behavior ---
		containerEl.createEl("h2", { text: "Behavior" });

		new Setting(containerEl)
			.setName("Auto-classify")
			.setDesc("Automatically send new messages to Claude for classification.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoClassify)
					.onChange(async (value) => {
						this.plugin.settings.autoClassify = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Fetch link content")
			.setDesc(
				"When a message contains URLs, fetch page titles and descriptions to give Claude richer context for classification."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fetchUrls)
					.onChange(async (value) => {
						this.plugin.settings.fetchUrls = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-file")
			.setDesc(
				"Automatically move classified messages to their destination folder. When off, messages are classified in place and you move them manually."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoFile)
					.onChange(async (value) => {
						this.plugin.settings.autoFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Poll interval (seconds)")
			.setDesc("How often to check for new messages in the inbox folder.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 120, 5)
					.setValue(this.plugin.settings.pollIntervalSeconds)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.pollIntervalSeconds = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Category Folders ---
		containerEl.createEl("h2", { text: "Category Folders" });
		containerEl.createEl("p", {
			text: "Where each message category gets filed. Paths are relative to your vault root.",
			cls: "setting-item-description",
		});

		const categories = Object.keys(CATEGORY_LABELS) as MessageCategory[];
		for (const category of categories) {
			new Setting(containerEl)
				.setName(CATEGORY_LABELS[category])
				.addText((text) =>
					text
						.setValue(this.plugin.settings.categoryFolders[category])
						.onChange(async (value) => {
							this.plugin.settings.categoryFolders[category] = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// --- Advanced ---
		containerEl.createEl("h2", { text: "Advanced" });

		new Setting(containerEl)
			.setName("Custom classification prompt")
			.setDesc(
				"Override the default prompt sent to Claude. Use {MESSAGE_CONTENT} as a placeholder for the message text. Leave blank for the default."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("Leave blank for default prompt")
					.setValue(this.plugin.settings.classificationPrompt)
					.onChange(async (value) => {
						this.plugin.settings.classificationPrompt = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
