import { App, PluginSettingTab, Setting } from "obsidian";
import type SignalInboxPlugin from "./main";
import type { MessageCategory } from "./types";

const CATEGORY_LABELS: Record<MessageCategory, string> = {
	article: "Articles & links",
	question: "Questions",
	task: "Tasks & action items",
	update: "Updates & FYIs",
	reference: "References & docs",
	idea: "Ideas & brainstorms",
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
		new Setting(containerEl).setName("Claude API").setHeading();

		new Setting(containerEl)
			.setName("API key")
			.setDesc("API key for message classification.")
			.addText((text) => {
				text
					.setPlaceholder("Enter API key")
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
					.addOption("claude-sonnet-4-20250514", "Sonnet 4")
					.addOption("claude-haiku-4-5-20251001", "Haiku 4.5 (faster, cheaper)")
					.setValue(this.plugin.settings.claudeModel)
					.onChange(async (value) => {
						this.plugin.settings.claudeModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Daily API limit")
			.setDesc(
				`Maximum API calls per day. Set to 0 for unlimited. Today: ${this.plugin.settings._apiCallsToday} call(s) used.`
			)
			.addText((text) =>
				text
					.setPlaceholder("100")
					.setValue(String(this.plugin.settings.dailyApiLimit))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.dailyApiLimit = num;
							await this.plugin.saveSettings();
						}
					})
			);

		// --- Inbox paths ---
		new Setting(containerEl).setName("Inbox paths").setHeading();

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
			.setDesc("Where processed messages are moved after classification.")
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
		new Setting(containerEl).setName("Behavior").setHeading();

		new Setting(containerEl)
			.setName("Auto-classify")
			.setDesc("Automatically send new messages for classification.")
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
				"Fetch page titles and descriptions for web links in the message."
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
				"Automatically move classified messages to their destination folder. When off, messages are classified and moved to the archive."
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
			.setName("Confidence threshold")
			.setDesc(
				`Minimum confidence score to auto-file (currently ${(this.plugin.settings.confidenceThreshold * 100).toFixed(0)}%). Messages below this are sent to the archive for manual review instead.`
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.1, 1.0, 0.05)
					.setValue(this.plugin.settings.confidenceThreshold)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.confidenceThreshold = value;
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

		// --- Category folders ---
		new Setting(containerEl).setName("Category folders").setHeading();

		new Setting(containerEl)
			.setDesc("Where each message category gets filed. Paths are relative to your vault root.");

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
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName("Custom classification prompt")
			.setDesc(
				"Override the default prompt sent to Claude. Use {MESSAGE_CONTENT} for message text and {URL_CONTEXT} for fetched link content. Leave blank for the default."
			)
			.addTextArea((text) => {
				text
					.setPlaceholder("Leave blank for default prompt")
					.setValue(this.plugin.settings.classificationPrompt)
					.onChange(async (value) => {
						this.plugin.settings.classificationPrompt = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 12;
				text.inputEl.addClass("signal-inbox-prompt-textarea");
			});
	}
}
