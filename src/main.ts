import {
  Plugin,
  Notice,
  Modal,
  App,
  Setting,
  PluginSettingTab,
  Platform,
  DropdownComponent,
  FileSystemAdapter,
} from "obsidian";
import { exec, ChildProcess, spawn } from "child_process";
import * as os from "os";
import * as fs from "fs/promises";

interface OpenInterpreterSettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  provider: "OpenAI" | "Anthropic";
  model: string;
}

const DEFAULT_SETTINGS: OpenInterpreterSettings = {
  openaiApiKey: "",
  anthropicApiKey: "",
  provider: "OpenAI",
  model: "gpt-4o",
};

class InstallationGuideModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    let { contentEl } = this;
    contentEl.setText("Open Interpreter is not installed.");
    contentEl.createEl("p", {
      text: "To install, run the following command in your terminal:",
    });
    contentEl.createEl("pre", { text: "pip install open-interpreter" });
    contentEl.createEl("p", { text: "For more information, visit:" });
    contentEl.createEl("a", {
      text: "Open Interpreter Documentation",
      href: "https://docs.openinterpreter.com/getting-started/introduction",
    });
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

class InterpreterInputModal extends Modal {
  result: string = "";
  onSubmit: (result: string) => void;

  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("interpreter-modal-content");

    contentEl.createEl("h2", {
      text: "Enter command for Open Interpreter",
      cls: "interpreter-modal-title",
    });

    const inputEl = contentEl.createEl("input", {
      type: "text",
      cls: "interpreter-modal-input",
      placeholder: "Enter your command...",
    });

    inputEl.addEventListener("input", (e) => {
      this.result = (e.target as HTMLInputElement).value;
    });

    inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.close();
        this.onSubmit(this.result);
      }
    });

    inputEl.focus();

    const submitButton = contentEl.createEl("button", {
      text: "Submit",
      cls: "submit-button",
    });

    submitButton.addEventListener("click", () => {
      this.close();
      this.onSubmit(this.result);
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class InterpreterChatModal extends Modal {
  private interpreter: ChildProcess;
  private inputEl!: HTMLTextAreaElement;
  private outputEl!: HTMLElement;
  private buttonContainer!: HTMLElement;
  private yesButton!: HTMLButtonElement;
  private noButton!: HTMLButtonElement;
  private sendButton!: HTMLButtonElement;

  constructor(app: App, interpreter: ChildProcess) {
    super(app);
    this.interpreter = interpreter;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("interpreter-modal-content");

    contentEl.createEl("h2", { text: "Open Interpreter Chat" });

    this.outputEl = contentEl.createEl("div", { cls: "interpreter-output" });

    this.createInputArea();
    this.createButtons();

    this.setupInterpreterListeners();
  }

  private setupInterpreterListeners() {
    if (this.interpreter.stdout) {
      this.interpreter.stdout.on("data", (data) => {
        this.appendOutput(data.toString());
      });
    }

    if (this.interpreter.stderr) {
      this.interpreter.stderr.on("data", (data) => {
        this.appendOutput(`Error: ${data.toString()}`, true);
      });
    }

    this.interpreter.on("close", (code) => {
      this.appendOutput(`Interpreter closed with code ${code}`);
      this.close();
    });
  }

  onClose() {
    this.interpreter.kill();
    const { contentEl } = this;
    contentEl.empty();
  }

  private appendOutput(text: string, isError: boolean = false) {
    const chunks = text.match(/.{1,1000}/g) || [];

    chunks.forEach((chunk) => {
      const p = this.outputEl.createEl("p");
      p.textContent = chunk;
      if (isError) {
        p.style.color = "red";
      }
    });

    this.outputEl.scrollTop = this.outputEl.scrollHeight;

    if (text.trim().endsWith("Would you like to run this code? (y/n)")) {
      this.showYesNoButtons();
    } else {
      this.showInputArea();
    }
  }

  private sendMessage(overrideMessage?: string) {
    let message: string;
    if (overrideMessage) {
      message = overrideMessage;
    } else {
      message = this.inputEl.value;
      this.inputEl.value = "";
    }

    if (this.interpreter.stdin) {
      this.interpreter.stdin.write(message + "\n");
    }
    this.appendOutput(`You: ${message}`);
    this.showInputArea();
  }

  private createInputArea() {
    this.inputEl = this.contentEl.createEl("textarea", {
      cls: "interpreter-input",
    });
  }

  private createButtons() {
    // Create Yes/No buttons container
    this.buttonContainer = this.contentEl.createEl("div", {
      cls: "yes-no-buttons",
    });

    // Create Yes button
    this.yesButton = this.buttonContainer.createEl("button", {
      text: "Yes",
      cls: "interpreter-chat-button yes",
    });
    this.yesButton.onclick = () => this.sendMessage("y");

    // Create No button
    this.noButton = this.buttonContainer.createEl("button", {
      text: "No",
      cls: "interpreter-chat-button no",
    });
    this.noButton.onclick = () => this.sendMessage("n");

    // Create Send button
    this.sendButton = this.contentEl.createEl("button", {
      text: "Send",
      cls: "interpreter-chat-button send",
    });
    this.sendButton.onclick = () => this.sendMessage();

    // Initially hide the Yes/No buttons
    this.buttonContainer.style.display = "none";
  }

  private showInputArea() {
    this.inputEl.style.display = "block";
    this.buttonContainer.style.display = "none";
    this.sendButton.style.display = "block";
  }

  private showYesNoButtons() {
    this.inputEl.style.display = "none";
    this.buttonContainer.style.display = "flex";
    this.sendButton.style.display = "none";
  }
}

export default class OpenInterpreterPlugin extends Plugin {
  settings!: OpenInterpreterSettings;
  private interpreterInstalled: boolean = false;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OpenInterpreterSettingTab(this.app, this));

    this.addCommand({
      id: "run-interpreter",
      name: "AI Command",
      callback: () => this.runInterpreter(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async checkInterpreterInstallation(): Promise<void> {
    return new Promise((resolve) => {
      const command = '$SHELL -i -c "which interpreter"';
      console.log("Executing command:", command);

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error("Error finding interpreter:", error);
          console.log("Stderr:", stderr);
          this.interpreterInstalled = false;
        } else {
          const interpreterPath = stdout.trim();
          console.log("Interpreter found at:", interpreterPath);
          this.interpreterInstalled = !!interpreterPath;
        }
        console.log("Interpreter installed:", this.interpreterInstalled);
        resolve();
      });
    });
  }

  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    console.error("Could not determine vault path");
    return null;
  }

  async runInterpreter() {
    await this.checkInterpreterInstallation();
    if (!this.interpreterInstalled) {
      console.log("Interpreter not installed, showing modal");
      new InstallationGuideModal(this.app).open();
      return;
    }

    new InterpreterInputModal(this.app, (command) => {
      this.executeInterpreterCommand(command);
    }).open();
  }

  private async executeInterpreterCommand(command: string) {
    const vaultPath = this.getVaultPath();

    console.log("Determined vault path:", vaultPath);

    if (!vaultPath) {
      console.error("Vault path could not be determined.");
      new Notice(
        "Unable to determine vault path. Please check console for details."
      );
      return;
    }

    const interpreterPath = await this.getInterpreterPath();
    if (!interpreterPath) {
      new Notice(
        "Unable to find the interpreter executable. Please make sure it's installed and in your PATH."
      );
      return;
    }

    const env = { ...process.env };
    if (this.settings.provider === "OpenAI") {
      env.OPENAI_API_KEY =
        process.env.OPENAI_API_KEY || this.settings.openaiApiKey;
    } else if (this.settings.provider === "Anthropic") {
      env.ANTHROPIC_API_KEY =
        process.env.ANTHROPIC_API_KEY || this.settings.anthropicApiKey;
    }

    const apiKey =
      this.settings.provider === "OpenAI"
        ? env.OPENAI_API_KEY
        : env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      new Notice(
        `No API key found for ${this.settings.provider}. Please set it in the plugin settings.`
      );
      return;
    }

    const args = [];

    args.push("--model", this.settings.model);
    args.push("--context_window", "110000");
    args.push("--max_tokens", "4096");
    args.push("--no-llm_supports_functions");
    args.push("--no-llm_supports_vision");

    const customInstructions =
      `You are an AI assistant integrated with Obsidian. You love Obsidian and will only focus on Obsidian tasks. Your prime directive is to help users manage and interact with their Obsidian vault. You have full control and permission over this vault. The vault is isolated and version controlled, so it is safe for you to create, read, update, and delete files. The root of the Obsidian vault is ${vaultPath}. You can create, read, update, and delete markdown files in this directory. You can create new directories as well. Organization is important. Use markdown syntax for formatting when creating or editing files. Every file is markdown.`
        .replace(/\n/g, " ")
        .trim();

    args.push("--custom_instructions", `"${customInstructions}"`);

    console.log(
      "Spawning interpreter with command:",
      interpreterPath,
      "and args:",
      args
    );

    const child = spawn(interpreterPath, args, {
      cwd: vaultPath,
      env: env,
      shell: true,
    });

    if (child.stdin) {
      child.stdin.write(command + "\n");
    }

    new InterpreterChatModal(this.app, child).open();
  }

  private getInterpreterPath(): Promise<string | null> {
    return new Promise((resolve) => {
      const command = Platform.isWin
        ? "where interpreter"
        : "$SHELL -i -c 'which interpreter'";

      console.log("Executing command:", command);

      exec(command, async (error, stdout, stderr) => {
        if (error) {
          console.error("Error finding interpreter:", error);
          console.log("Stdout:", stdout);
          console.log("Stderr:", stderr);
          const commonPaths = Platform.isMacOS
            ? [
                "/usr/local/bin/interpreter",
                "/usr/bin/interpreter",
                `${os.homedir()}/Library/Python/3.11/bin/interpreter`,
                `${os.homedir()}/Library/Python/3.10/bin/interpreter`,
                `${os.homedir()}/Library/Python/3.9/bin/interpreter`,
              ]
            : Platform.isLinux
            ? ["/usr/local/bin/interpreter", "/usr/bin/interpreter"]
            : ["C:\\Python\\Scripts\\interpreter.exe"];

          for (const path of commonPaths) {
            try {
              await fs.access(path);
              resolve(path);
              return;
            } catch {
              // Path doesn't exist or is not accessible, continue to next path
            }
          }
          resolve(null);
        } else {
          console.log("Interpreter found at:", stdout.trim());
          resolve(stdout.trim());
        }
      });
    });
  }

  onunload() {
    console.log("unloading open interpreter plugin");
  }
}

class OpenInterpreterSettingTab extends PluginSettingTab {
  plugin: OpenInterpreterPlugin;
  private openAIApiKeySetting: Setting | null = null;
  private anthropicApiKeySetting: Setting | null = null;
  private modelDropdown: DropdownComponent | null = null;

  constructor(app: App, plugin: OpenInterpreterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Select the LLM provider")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("OpenAI", "OpenAI")
          .addOption("Anthropic", "Anthropic")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value as "OpenAI" | "Anthropic";
            await this.plugin.saveSettings();
            this.updateApiKeyVisibility();
            this.updateModelOptions();
          })
      );

    this.openAIApiKeySetting = new Setting(containerEl)
      .setName("OpenAI API Key")
      .setDesc("Enter your OpenAI API key")
      .addText((text) =>
        text
          .setPlaceholder("Enter your OpenAI API key")
          .setValue(this.plugin.settings.openaiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openaiApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    this.anthropicApiKeySetting = new Setting(containerEl)
      .setName("Anthropic API Key")
      .setDesc("Enter your Anthropic API key")
      .addText((text) =>
        text
          .setPlaceholder("Enter your Anthropic API key")
          .setValue(this.plugin.settings.anthropicApiKey)
          .onChange(async (value) => {
            this.plugin.settings.anthropicApiKey = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Select the LLM model")
      .addDropdown((dropdown) => {
        this.modelDropdown = dropdown;
        this.updateModelOptions();
        dropdown.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    this.updateApiKeyVisibility();
  }

  private updateApiKeyVisibility() {
    if (this.openAIApiKeySetting && this.anthropicApiKeySetting) {
      if (this.plugin.settings.provider === "OpenAI") {
        this.openAIApiKeySetting.settingEl.style.display = "block";
        this.anthropicApiKeySetting.settingEl.style.display = "none";
      } else {
        this.openAIApiKeySetting.settingEl.style.display = "none";
        this.anthropicApiKeySetting.settingEl.style.display = "block";
      }
    }
  }

  private updateModelOptions() {
    if (this.modelDropdown) {
      const models = this.getModelsForProvider(this.plugin.settings.provider);
      // Remove all existing options
      this.modelDropdown.selectEl.empty();
      // Add new options
      Object.entries(models).forEach(([value, name]) => {
        this.modelDropdown?.addOption(value, name);
      });

      // Set the first model as default if the current model is not in the list
      if (!models[this.plugin.settings.model]) {
        this.plugin.settings.model = Object.keys(models)[0];
        this.plugin.saveSettings();
      }

      this.modelDropdown.setValue(this.plugin.settings.model);
    }
  }

  private getModelsForProvider(
    provider: "OpenAI" | "Anthropic"
  ): Record<string, string> {
    switch (provider) {
      case "OpenAI":
        return {
          "gpt-4o": "GPT-4o",
          "gpt-4o-mini": "GPT-4o-mini",
        };
      case "Anthropic":
        return {
          "claude-3-5-sonnet-20241022": "Claude 3.5 Sonnet",
          "claude-3-opus-20240229": "Claude 3 Opus",
        };
      default:
        console.error(`Unknown provider: ${provider}`);
        return {};
    }
  }
}
